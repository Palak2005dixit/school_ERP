import {
  staffAttendanceCorrectionInput,
  staffAttendanceInput,
  staffAttendanceReviewInput,
  staffAttendanceSettingsInput,
  staffShiftInput,
  staffShiftUpdate,
  uuid,
  type StaffAttendanceCorrection,
  type StaffAttendanceRecord,
  type StaffAttendanceSettings,
  type StaffAttendanceSummary,
  type StaffShift,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, conflict, notFound, parseInput } from '../lib/errors';
import { toIsoDate, toIsoDateTime, toNumber } from '../lib/format';
import { idempotentRoute } from '../lib/idempotency';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const attendanceQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  staffId: uuid.optional(),
  status: z
    .enum(['present', 'late', 'absent', 'half_day', 'leave', 'excused', 'missing_punch'])
    .optional(),
});
const correctionQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

/**
 * Staff timekeeping. Punches are recorded as supplied by the school; the API
 * derives late/early/overtime minutes from the assigned shift and the school's
 * thresholds (D-037, provisional until the client confirms policy). A single
 * punch is stored as missing_punch and must be corrected before payroll uses it.
 */
export async function registerStaffAttendanceRoutes(app: FastifyInstance): Promise<void> {
  /* --------------------------------- shifts -------------------------------- */

  app.get(
    '/api/schools/:schoolId/staff/shifts',
    { preHandler: requirePermission('hr.attendance.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        code: string;
        name: string;
        starts_at: string;
        ends_at: string;
        grace_minutes: number;
        break_minutes: number;
        active: boolean;
      }>(
        `SELECT id, code, name, starts_at::text, ends_at::text, grace_minutes,
                break_minutes, active
         FROM staff_shifts WHERE school_id = $1 ORDER BY starts_at, name`,
        [schoolId],
      );
      const items: StaffShift[] = rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        startsAt: row.starts_at.slice(0, 5),
        endsAt: row.ends_at.slice(0, 5),
        graceMinutes: row.grace_minutes,
        breakMinutes: row.break_minutes,
        active: row.active,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/staff/shifts',
    { preHandler: requirePermission('hr.attendance.configure') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(staffShiftInput, request.body);
      const actor = getActor(request);
      if (input.endsAt <= input.startsAt) {
        throw badRequest('The shift end must be after its start', {
          endsAt: ['Choose a time after the start time'],
        });
      }
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO staff_shifts
           (school_id, code, name, starts_at, ends_at, grace_minutes, break_minutes, active)
         VALUES ($1, $2, $3, $4::time, $5::time, $6, $7, $8) RETURNING id`,
        [
          schoolId,
          input.code,
          input.name,
          input.startsAt,
          input.endsAt,
          input.graceMinutes,
          input.breakMinutes,
          input.active,
        ],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'hr.shift_created',
        entityType: 'staff_shift',
        entityId: rows[0]!.id,
        outcome: 'success',
        after: input,
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  app.patch(
    '/api/schools/:schoolId/staff/shifts/:id',
    { preHandler: requirePermission('hr.attendance.configure') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(staffShiftUpdate, request.body);
      const actor = getActor(request);
      const existing = await getPool().query<{ starts_at: string; ends_at: string }>(
        'SELECT starts_at::text, ends_at::text FROM staff_shifts WHERE school_id = $1 AND id = $2',
        [schoolId, id],
      );
      if (!existing.rows[0]) throw notFound('Shift not found');
      const startsAt = input.startsAt ?? existing.rows[0].starts_at.slice(0, 5);
      const endsAt = input.endsAt ?? existing.rows[0].ends_at.slice(0, 5);
      if (endsAt <= startsAt) throw badRequest('The shift end must be after its start');
      const { rows } = await getPool().query<{ id: string }>(
        `UPDATE staff_shifts SET
           code = COALESCE($3, code), name = COALESCE($4, name),
           starts_at = COALESCE($5::time, starts_at), ends_at = COALESCE($6::time, ends_at),
           grace_minutes = COALESCE($7, grace_minutes),
           break_minutes = COALESCE($8, break_minutes), active = COALESCE($9, active)
         WHERE school_id = $1 AND id = $2 RETURNING id`,
        [
          schoolId,
          id,
          input.code ?? null,
          input.name ?? null,
          input.startsAt ?? null,
          input.endsAt ?? null,
          input.graceMinutes ?? null,
          input.breakMinutes ?? null,
          input.active ?? null,
        ],
      );
      if (!rows[0]) throw notFound('Shift not found');
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'hr.shift_updated',
        entityType: 'staff_shift',
        entityId: id,
        outcome: 'success',
        after: input,
        ...requestMeta(request),
      });
      return { id };
    },
  );

  /* ------------------------------ attendance ------------------------------- */

  app.get(
    '/api/schools/:schoolId/staff/attendance',
    { preHandler: requirePermission('hr.attendance.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(attendanceQuery, request.query);
      const params: unknown[] = [schoolId];
      const filters = ['a.school_id = $1'];
      if (query.from) {
        params.push(query.from);
        filters.push(`a.work_date >= $${params.length}`);
      }
      if (query.to) {
        params.push(query.to);
        filters.push(`a.work_date <= $${params.length}`);
      }
      if (query.staffId) {
        params.push(query.staffId);
        filters.push(`a.staff_id = $${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        filters.push(`a.status = $${params.length}`);
      }
      const { rows } = await getPool().query<{
        id: string;
        staff_id: string;
        first_name: string;
        last_name: string | null;
        employee_number: string;
        shift_id: string | null;
        shift_name: string | null;
        work_date: string;
        punch_in: Date | null;
        punch_out: Date | null;
        status: StaffAttendanceRecord['status'];
        late_minutes: number;
        early_departure_minutes: number;
        overtime_minutes: number;
        note: string | null;
        pending_correction: boolean;
      }>(
        `SELECT a.id, a.staff_id, s.first_name, s.last_name, s.employee_number,
                a.shift_id, sh.name AS shift_name, a.work_date, a.punch_in, a.punch_out,
                a.status, a.late_minutes, a.early_departure_minutes, a.overtime_minutes,
                a.note,
                EXISTS (
                  SELECT 1 FROM staff_attendance_corrections c
                  WHERE c.school_id = a.school_id AND c.attendance_id = a.id
                    AND c.status = 'pending'
                ) AS pending_correction
         FROM staff_attendance a
         JOIN staff s ON s.id = a.staff_id AND s.school_id = a.school_id
         LEFT JOIN staff_shifts sh ON sh.id = a.shift_id AND sh.school_id = a.school_id
         WHERE ${filters.join(' AND ')}
         ORDER BY a.work_date DESC, s.first_name, s.last_name
         LIMIT 500`,
        params,
      );
      const items: StaffAttendanceRecord[] = rows.map((row) => ({
        id: row.id,
        staffId: row.staff_id,
        staffName: [row.first_name, row.last_name].filter(Boolean).join(' '),
        employeeNumber: row.employee_number,
        shiftId: row.shift_id,
        shiftName: row.shift_name,
        workDate: toIsoDate(row.work_date),
        punchIn: row.punch_in ? toIsoDateTime(row.punch_in) : null,
        punchOut: row.punch_out ? toIsoDateTime(row.punch_out) : null,
        status: row.status,
        lateMinutes: row.late_minutes,
        earlyDepartureMinutes: row.early_departure_minutes,
        overtimeMinutes: row.overtime_minutes,
        note: row.note,
        pendingCorrection: row.pending_correction,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/staff/attendance',
    { preHandler: requirePermission('hr.attendance.record') },
    idempotentRoute('POST /staff/attendance', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(staffAttendanceInput, request.body);
      const actor = getActor(request);
      const created = await withTransaction(async (client) => {
        const staff = await client.query(
          'SELECT 1 FROM staff WHERE school_id = $1 AND id = $2',
          [schoolId, input.staffId],
        );
        if (staff.rowCount === 0) throw notFound('Staff member not found');

        const settings = await loadSettings(client, schoolId);
        const shift = input.shiftId
          ? await loadShift(client, schoolId, input.shiftId)
          : await assignedShift(client, schoolId, input.staffId, input.workDate);

        const computed = computeAttendance({
          punchIn: input.punchIn ?? null,
          punchOut: input.punchOut ?? null,
          requestedStatus: input.status,
          shift,
          overtimeAfterMinutes: settings.overtimeAfterMinutes,
          timeZone: actor.school.timezone,
        });

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO staff_attendance
             (school_id, staff_id, shift_id, work_date, punch_in, punch_out, status,
              late_minutes, early_departure_minutes, overtime_minutes, note, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (school_id, staff_id, work_date) DO UPDATE SET
             shift_id = EXCLUDED.shift_id, punch_in = EXCLUDED.punch_in,
             punch_out = EXCLUDED.punch_out, status = EXCLUDED.status,
             late_minutes = EXCLUDED.late_minutes,
             early_departure_minutes = EXCLUDED.early_departure_minutes,
             overtime_minutes = EXCLUDED.overtime_minutes,
             note = EXCLUDED.note, recorded_by = EXCLUDED.recorded_by
           RETURNING id`,
          [
            schoolId,
            input.staffId,
            shift?.id ?? null,
            input.workDate,
            input.punchIn ?? null,
            input.punchOut ?? null,
            computed.status,
            computed.lateMinutes,
            computed.earlyDepartureMinutes,
            computed.overtimeMinutes,
            input.note ?? null,
            actor.userId,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.staff_attendance_recorded',
          entityType: 'staff_attendance',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: {
            staffId: input.staffId,
            workDate: input.workDate,
            status: computed.status,
            lateMinutes: computed.lateMinutes,
            overtimeMinutes: computed.overtimeMinutes,
          },
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });
      return reply.status(201).send({ id: created });
    }),
  );

  app.get(
    '/api/schools/:schoolId/staff/attendance/summary',
    { preHandler: requirePermission('hr.attendance.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(attendanceQuery, request.query);
      return attendanceSummary(schoolId, query.from, query.to);
    },
  );

  /* ------------------------------- corrections ----------------------------- */

  app.get(
    '/api/schools/:schoolId/staff/attendance/corrections',
    { preHandler: requirePermission('hr.attendance.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(correctionQuery, request.query);
      const params: unknown[] = [schoolId];
      let filter = '';
      if (query.status) {
        params.push(query.status);
        filter = `AND c.status = $${params.length}`;
      }
      const { rows } = await getPool().query<{
        id: string;
        attendance_id: string;
        staff_name: string;
        work_date: string;
        current_status: StaffAttendanceRecord['status'];
        requested_status: StaffAttendanceRecord['status'] | null;
        requested_punch_in: Date | null;
        requested_punch_out: Date | null;
        reason: string;
        status: StaffAttendanceCorrection['status'];
        requested_by_name: string | null;
        requested_at: Date;
        reviewed_by_name: string | null;
        reviewed_at: Date | null;
        review_note: string | null;
      }>(
        `SELECT c.id, c.attendance_id,
                concat_ws(' ', s.first_name, s.last_name) AS staff_name,
                a.work_date, a.status AS current_status,
                c.requested_status, c.requested_punch_in, c.requested_punch_out,
                c.reason, c.status,
                ru.display_name AS requested_by_name, c.requested_at,
                vu.display_name AS reviewed_by_name, c.reviewed_at, c.review_note
         FROM staff_attendance_corrections c
         JOIN staff_attendance a ON a.id = c.attendance_id AND a.school_id = c.school_id
         JOIN staff s ON s.id = a.staff_id AND s.school_id = a.school_id
         LEFT JOIN users ru ON ru.id = c.requested_by
         LEFT JOIN users vu ON vu.id = c.reviewed_by
         WHERE c.school_id = $1 ${filter}
         ORDER BY c.requested_at DESC`,
        params,
      );
      const items: StaffAttendanceCorrection[] = rows.map((row) => ({
        id: row.id,
        attendanceId: row.attendance_id,
        staffName: row.staff_name,
        workDate: toIsoDate(row.work_date),
        currentStatus: row.current_status,
        requestedStatus: row.requested_status,
        requestedPunchIn: row.requested_punch_in
          ? toIsoDateTime(row.requested_punch_in)
          : null,
        requestedPunchOut: row.requested_punch_out
          ? toIsoDateTime(row.requested_punch_out)
          : null,
        reason: row.reason,
        status: row.status,
        requestedByName: row.requested_by_name,
        requestedAt: toIsoDateTime(row.requested_at),
        reviewedByName: row.reviewed_by_name,
        reviewedAt: row.reviewed_at ? toIsoDateTime(row.reviewed_at) : null,
        reviewNote: row.review_note,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/staff/attendance/:id/corrections',
    { preHandler: requirePermission('hr.attendance.record') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(staffAttendanceCorrectionInput, request.body);
      const actor = getActor(request);
      if (
        input.requestedStatus === undefined &&
        input.requestedPunchIn === undefined &&
        input.requestedPunchOut === undefined
      ) {
        throw badRequest('Choose a corrected status or punch time');
      }
      const attendance = await getPool().query(
        'SELECT 1 FROM staff_attendance WHERE school_id = $1 AND id = $2',
        [schoolId, id],
      );
      if (attendance.rowCount === 0) throw notFound('Attendance record not found');
      const pending = await getPool().query(
        `SELECT 1 FROM staff_attendance_corrections
         WHERE school_id = $1 AND attendance_id = $2 AND status = 'pending'`,
        [schoolId, id],
      );
      if (pending.rowCount) throw conflict('A correction is already awaiting review');
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO staff_attendance_corrections
           (school_id, attendance_id, requested_status, requested_punch_in,
            requested_punch_out, reason, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          schoolId,
          id,
          input.requestedStatus ?? null,
          input.requestedPunchIn ?? null,
          input.requestedPunchOut ?? null,
          input.reason,
          actor.userId,
        ],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'hr.staff_attendance_correction_requested',
        entityType: 'staff_attendance_correction',
        entityId: rows[0]!.id,
        outcome: 'success',
        after: { attendanceId: id, reason: input.reason },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  app.post(
    '/api/schools/:schoolId/staff/attendance/corrections/:id/review',
    { preHandler: requirePermission('hr.attendance.approve') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(staffAttendanceReviewInput, request.body);
      const actor = getActor(request);
      await withTransaction(async (client) => {
        const found = await client.query<{
          attendance_id: string;
          requested_status: StaffAttendanceRecord['status'] | null;
          requested_punch_in: Date | null;
          requested_punch_out: Date | null;
          status: string;
          requested_by: string;
        }>(
          `SELECT attendance_id, requested_status, requested_punch_in,
                  requested_punch_out, status, requested_by
           FROM staff_attendance_corrections
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const correction = found.rows[0];
        if (!correction) throw notFound('Correction not found');
        if (correction.status !== 'pending') throw conflict('This correction was already reviewed');
        if (correction.requested_by === actor.userId) {
          throw conflict('You cannot review your own correction request');
        }

        await client.query(
          `UPDATE staff_attendance_corrections
           SET status = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5
           WHERE school_id = $1 AND id = $2`,
          [schoolId, id, input.decision === 'approve' ? 'approved' : 'rejected',
            actor.userId, input.note ?? null],
        );

        if (input.decision === 'approve') {
          const attendance = await client.query<{
            staff_id: string;
            shift_id: string | null;
            work_date: string;
            punch_in: Date | null;
            punch_out: Date | null;
            status: StaffAttendanceRecord['status'];
          }>(
            `SELECT staff_id, shift_id, work_date, punch_in, punch_out, status
             FROM staff_attendance WHERE school_id = $1 AND id = $2 FOR UPDATE`,
            [schoolId, correction.attendance_id],
          );
          const row = attendance.rows[0]!;
          const settings = await loadSettings(client, schoolId);
          const shift = row.shift_id
            ? await loadShift(client, schoolId, row.shift_id)
            : null;
          const computed = computeAttendance({
            punchIn: correction.requested_punch_in
              ? toIsoDateTime(correction.requested_punch_in)
              : row.punch_in
                ? toIsoDateTime(row.punch_in)
                : null,
            punchOut: correction.requested_punch_out
              ? toIsoDateTime(correction.requested_punch_out)
              : row.punch_out
                ? toIsoDateTime(row.punch_out)
                : null,
            requestedStatus: correction.requested_status ?? row.status,
            shift,
            overtimeAfterMinutes: settings.overtimeAfterMinutes,
            timeZone: actor.school.timezone,
          });
          await client.query(
            `UPDATE staff_attendance SET
               punch_in = $3, punch_out = $4, status = $5, late_minutes = $6,
               early_departure_minutes = $7, overtime_minutes = $8
             WHERE school_id = $1 AND id = $2`,
            [
              schoolId,
              correction.attendance_id,
              correction.requested_punch_in ?? row.punch_in,
              correction.requested_punch_out ?? row.punch_out,
              computed.status,
              computed.lateMinutes,
              computed.earlyDepartureMinutes,
              computed.overtimeMinutes,
            ],
          );
        }

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.staff_attendance_correction_reviewed',
          entityType: 'staff_attendance_correction',
          entityId: id,
          outcome: 'success',
          after: { decision: input.decision },
          ...requestMeta(request),
        });
      });
      return { id, status: input.decision === 'approve' ? 'approved' : 'rejected' };
    },
  );

  /* -------------------------------- settings ------------------------------- */

  app.get(
    '/api/schools/:schoolId/staff/attendance/settings',
    { preHandler: requirePermission('hr.attendance.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      return loadSettings(getPool(), schoolId);
    },
  );

  app.put(
    '/api/schools/:schoolId/staff/attendance/settings',
    { preHandler: requirePermission('hr.attendance.configure') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(staffAttendanceSettingsInput, request.body);
      if (input.halfDayMinutes > input.fullDayMinutes) {
        throw badRequest('Half-day minutes cannot exceed full-day minutes', {
          halfDayMinutes: ['Use a value no larger than full-day minutes'],
        });
      }
      const actor = getActor(request);
      await getPool().query(
        `INSERT INTO staff_attendance_settings
           (school_id, full_day_minutes, half_day_minutes, overtime_after_minutes, active)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (school_id) DO UPDATE SET
           full_day_minutes = EXCLUDED.full_day_minutes,
           half_day_minutes = EXCLUDED.half_day_minutes,
           overtime_after_minutes = EXCLUDED.overtime_after_minutes,
           active = EXCLUDED.active, updated_at = now()`,
        [schoolId, input.fullDayMinutes, input.halfDayMinutes, input.overtimeAfterMinutes, input.active],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'hr.staff_attendance_settings_updated',
        entityType: 'staff_attendance_settings',
        entityId: schoolId,
        outcome: 'success',
        after: input,
        ...requestMeta(request),
      });
      return input satisfies StaffAttendanceSettings;
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

interface ShiftRow {
  id: string;
  startsAt: string;
  endsAt: string;
  graceMinutes: number;
  breakMinutes: number;
}

async function loadShift(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  shiftId: string,
): Promise<ShiftRow | null> {
  const { rows } = await client.query<{
    id: string;
    starts_at: string;
    ends_at: string;
    grace_minutes: number;
    break_minutes: number;
  }>(
    `SELECT id, starts_at::text, ends_at::text, grace_minutes, break_minutes
     FROM staff_shifts WHERE school_id = $1 AND id = $2`,
    [schoolId, shiftId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    startsAt: row.starts_at.slice(0, 5),
    endsAt: row.ends_at.slice(0, 5),
    graceMinutes: row.grace_minutes,
    breakMinutes: row.break_minutes,
  };
}

async function assignedShift(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  staffId: string,
  workDate: string,
): Promise<ShiftRow | null> {
  const { rows } = await client.query<{ shift_id: string }>(
    `SELECT shift_id FROM staff_shift_assignments
     WHERE school_id = $1 AND staff_id = $2
       AND effective_from <= $3
       AND (effective_to IS NULL OR effective_to >= $3)
     ORDER BY effective_from DESC LIMIT 1`,
    [schoolId, staffId, workDate],
  );
  return rows[0] ? loadShift(client, schoolId, rows[0].shift_id) : null;
}

async function loadSettings(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
): Promise<StaffAttendanceSettings> {
  const { rows } = await client.query<{
    full_day_minutes: number;
    half_day_minutes: number;
    overtime_after_minutes: number;
    active: boolean;
  }>(
    `SELECT full_day_minutes, half_day_minutes, overtime_after_minutes, active
     FROM staff_attendance_settings WHERE school_id = $1`,
    [schoolId],
  );
  const row = rows[0];
  if (!row) {
    return {
      fullDayMinutes: 480,
      halfDayMinutes: 240,
      overtimeAfterMinutes: 30,
      active: true,
    };
  }
  return {
    fullDayMinutes: row.full_day_minutes,
    halfDayMinutes: row.half_day_minutes,
    overtimeAfterMinutes: row.overtime_after_minutes,
    active: row.active,
  };
}

function minutesOfTime(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function minutesInZone(iso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function computeAttendance(input: {
  punchIn: string | null;
  punchOut: string | null;
  requestedStatus: StaffAttendanceRecord['status'] | undefined;
  shift: ShiftRow | null;
  overtimeAfterMinutes: number;
  timeZone: string;
}): {
  status: StaffAttendanceRecord['status'];
  lateMinutes: number;
  earlyDepartureMinutes: number;
  overtimeMinutes: number;
} {
  const { punchIn, punchOut, shift, requestedStatus, timeZone } = input;
  if (!punchIn && !punchOut && !requestedStatus) {
    throw badRequest('Record a punch time or choose a status');
  }
  if ((punchIn && !punchOut) || (!punchIn && punchOut)) {
    return {
      status: 'missing_punch',
      lateMinutes: 0,
      earlyDepartureMinutes: 0,
      overtimeMinutes: 0,
    };
  }
  if (!punchIn || !punchOut || !shift) {
    return {
      status: requestedStatus ?? 'present',
      lateMinutes: 0,
      earlyDepartureMinutes: 0,
      overtimeMinutes: 0,
    };
  }

  const start = minutesOfTime(shift.startsAt);
  const end = minutesOfTime(shift.endsAt);
  const inMinutes = minutesInZone(punchIn, timeZone);
  const outMinutes = minutesInZone(punchOut, timeZone);
  const lateMinutes = Math.max(0, inMinutes - start - shift.graceMinutes);
  const earlyDepartureMinutes = Math.max(0, end - outMinutes);
  const worked = Math.max(0, outMinutes - inMinutes - shift.breakMinutes);
  const overtimeMinutes = Math.max(
    0,
    worked - (end - start) - input.overtimeAfterMinutes,
  );
  const autoStatus: StaffAttendanceRecord['status'] =
    lateMinutes > 0 ? 'late' : 'present';
  return {
    status: requestedStatus ?? autoStatus,
    lateMinutes,
    earlyDepartureMinutes,
    overtimeMinutes,
  };
}

async function attendanceSummary(
  schoolId: string,
  from: string | undefined,
  to: string | undefined,
): Promise<StaffAttendanceSummary> {
  const params: unknown[] = [schoolId];
  const filters = ['a.school_id = $1'];
  if (from) {
    params.push(from);
    filters.push(`a.work_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    filters.push(`a.work_date <= $${params.length}`);
  }
  const { rows } = await getPool().query<{
    staff_id: string;
    staff_name: string;
    days_marked: string;
    present: string;
    absent: string;
    late: string;
    leave: string;
    overtime_minutes: string;
  }>(
    `SELECT a.staff_id, concat_ws(' ', s.first_name, s.last_name) AS staff_name,
            count(*)::text AS days_marked,
            count(*) FILTER (WHERE a.status IN ('present', 'late', 'half_day'))::text AS present,
            count(*) FILTER (WHERE a.status = 'absent')::text AS absent,
            count(*) FILTER (WHERE a.status = 'late')::text AS late,
            count(*) FILTER (WHERE a.status = 'leave')::text AS leave,
            COALESCE(sum(a.overtime_minutes), 0)::text AS overtime_minutes
     FROM staff_attendance a
     JOIN staff s ON s.id = a.staff_id AND s.school_id = a.school_id
     WHERE ${filters.join(' AND ')}
     GROUP BY a.staff_id, s.first_name, s.last_name
     ORDER BY staff_name`,
    params,
  );

  const totals = await getPool().query<{
    present: string;
    absent: string;
    late: string;
    leave: string;
    missing_punch: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE status IN ('present', 'late', 'half_day'))::text AS present,
       count(*) FILTER (WHERE status = 'absent')::text AS absent,
       count(*) FILTER (WHERE status = 'late')::text AS late,
       count(*) FILTER (WHERE status = 'leave')::text AS leave,
       count(*) FILTER (WHERE status = 'missing_punch')::text AS missing_punch
     FROM staff_attendance a WHERE ${filters.join(' AND ')}`,
    params,
  );

  const staffRows = rows.map((row) => ({
    staffId: row.staff_id,
    staffName: row.staff_name,
    daysMarked: toNumber(row.days_marked),
    present: toNumber(row.present),
    absent: toNumber(row.absent),
    late: toNumber(row.late),
    leave: toNumber(row.leave),
    overtimeMinutes: toNumber(row.overtime_minutes),
  }));
  const totalOvertime = staffRows.reduce((sum, row) => sum + row.overtimeMinutes, 0);
  const totalDays = staffRows.reduce((sum, row) => sum + row.daysMarked, 0);
  const agg = totals.rows[0];
  return {
    from: from ?? '',
    to: to ?? '',
    present: toNumber(agg?.present),
    absent: toNumber(agg?.absent),
    late: toNumber(agg?.late),
    leave: toNumber(agg?.leave),
    missingPunch: toNumber(agg?.missing_punch),
    averageMinutes: totalDays > 0 ? Math.round(totalOvertime / totalDays) : 0,
    staff: staffRows,
  };
}
