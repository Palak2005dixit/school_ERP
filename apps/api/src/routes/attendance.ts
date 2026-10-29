import { canAccessSection, fullName, visibleSectionIds } from '@erp/core';
import {
  attendanceCorrectionInput,
  attendanceRegisterInput,
  attendanceRegisterQuery,
  attendanceReviewInput,
  uuid,
  type AttendanceCorrection,
  type AttendanceRegister,
  type AttendanceRegisterRow,
  type AttendanceSaveResult,
  type AttendanceSectionSummary,
  type AttendanceStatus,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import type { ActorContext } from '../auth/session';
import { getPool, withTransaction } from '../db';
import { recordActivity, recordAudit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound, parseInput } from '../lib/errors';
import { toIsoDate, todayInTimeZone } from '../lib/format';

const schoolParams = z.object({ schoolId: uuid });
const correctionParams = z.object({ schoolId: uuid, id: uuid });

/**
 * Daily attendance register and correction workflow.
 *
 * A register row is created once. After that, changing a status requires a
 * correction request from a user with record permission; a different user with
 * approval permission accepts or rejects it. The original status is never
 * overwritten before an approval commits.
 */
export async function registerAttendanceRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/schools/:schoolId/attendance/register',
    { preHandler: requirePermission('attendance.register.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(attendanceRegisterQuery, request.query);
      const actor = getActor(request);

      return withTransaction(async (client) => {
        const section = await loadSection(client, schoolId, query.sectionId);
        if (!section || !canAccessSection(actor, section.id)) throw notFound('Section not found');
        return buildRegister(client, actor, section, query.date);
      });
    },
  );

  app.post(
    '/api/schools/:schoolId/attendance/register',
    { preHandler: requirePermission('attendance.student.record') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(attendanceRegisterInput, request.body);

      const result = await withTransaction(async (client): Promise<AttendanceSaveResult> => {
        const section = await loadSection(client, schoolId, input.sectionId);
        if (!section || !canAccessSection(actor, section.id)) throw notFound('Section not found');
        assertDateRecordable(section, input.date, actor);

        const studentIds = input.entries.map((entry) => entry.studentId);
        if (new Set(studentIds).size !== studentIds.length) {
          throw badRequest('Each student can appear only once in a register', {
            entries: ['Remove duplicate students'],
          });
        }

        const enrolled = await client.query<{ student_id: string; enrollment_id: string }>(
          `SELECT e.student_id, e.id AS enrollment_id
           FROM enrollments e
           WHERE e.school_id = $1 AND e.section_id = $2
             AND e.enrollment_status = 'active'
             AND e.starts_on <= $3::date
             AND (e.ends_on IS NULL OR e.ends_on >= $3::date)
             AND e.student_id = ANY($4::uuid[])`,
          [schoolId, section.id, input.date, studentIds],
        );
        const enrollmentByStudent = new Map(
          enrolled.rows.map((row) => [row.student_id, row.enrollment_id]),
        );
        const missing = studentIds.filter((studentId) => !enrollmentByStudent.has(studentId));
        if (missing.length > 0) {
          throw badRequest(
            'Some students are not actively enrolled in this section on the selected date',
            { entries: [`Not enrolled on this date: ${missing.join(', ')}`] },
          );
        }

        let inserted = 0;
        for (const entry of input.entries) {
          const enrollmentId = enrollmentByStudent.get(entry.studentId)!;
          const { rowCount } = await client.query(
            `INSERT INTO student_attendance
               (school_id, student_id, enrollment_id, attendance_date, status, source, recorded_by, note)
             VALUES ($1, $2, $3, $4::date, $5, 'manual', $6, $7)
             ON CONFLICT (enrollment_id, attendance_date) DO NOTHING`,
            [
              schoolId,
              entry.studentId,
              enrollmentId,
              input.date,
              entry.status,
              actor.userId,
              entry.note ?? null,
            ],
          );
          if (rowCount === 1) inserted += 1;
        }
        const skipped = input.entries.length - inserted;

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'attendance.register_saved',
          entityType: 'section',
          entityId: section.id,
          outcome: 'success',
          after: {
            date: input.date,
            class: `${section.class_name} · ${section.name}`,
            inserted,
            skipped,
          },
          ...requestMeta(request),
        });

        if (inserted > 0) {
          await recordActivity(client, {
            schoolId,
            entityType: 'section',
            entityId: section.id,
            eventType: 'attendance.register_saved',
            actorUserId: actor.userId,
            summary: `Attendance saved for ${section.class_name} · ${section.name} on ${input.date} (${inserted} ${
              inserted === 1 ? 'student' : 'students'
            })`,
          });
        }

        const register = await buildRegister(client, actor, section, input.date);
        return { inserted, skipped, register };
      });

      return reply.status(result.inserted > 0 ? 201 : 200).send(result);
    },
  );

  app.get(
    '/api/schools/:schoolId/attendance/corrections',
    { preHandler: requirePermission('attendance.correction.approve') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const restricted = visibleSectionIds(actor);

      const params: unknown[] = [schoolId];
      let scopeFilter = '';
      if (restricted) {
        params.push(restricted);
        scopeFilter = `AND e.section_id = ANY($${params.length}::uuid[])`;
      }

      const { rows } = await getPool().query<CorrectionRow>(
        `${correctionSelect}
         WHERE c.school_id = $1 AND c.status = 'pending' ${scopeFilter}
         ORDER BY c.requested_at`,
        params,
      );

      return { items: rows.map(mapCorrection) };
    },
  );

  app.post(
    '/api/schools/:schoolId/attendance/corrections',
    { preHandler: requirePermission('attendance.student.record') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(attendanceCorrectionInput, request.body);

      const correction = await withTransaction(async (client) => {
        const attendance = await loadAttendanceContext(client, schoolId, input.attendanceId, false);
        if (!attendance || !canAccessSection(actor, attendance.section_id)) {
          throw notFound('Attendance record not found');
        }
        if (attendance.status === input.requestedStatus) {
          throw badRequest('Choose a status different from the current one', {
            requestedStatus: ['The requested status matches the current status'],
          });
        }

        const pending = await client.query<{ id: string }>(
          `SELECT id FROM attendance_corrections
           WHERE school_id = $1 AND attendance_id = $2 AND status = 'pending'`,
          [schoolId, input.attendanceId],
        );
        if (pending.rows[0]) {
          throw conflict(
            'A correction is already awaiting review for this student and date',
            'correction_pending',
          );
        }

        const created = await client.query<{ id: string }>(
          `INSERT INTO attendance_corrections
             (school_id, attendance_id, requested_status, reason, requested_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [schoolId, input.attendanceId, input.requestedStatus, input.reason, actor.userId],
        );
        const correctionId = created.rows[0]!.id;

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'attendance.correction_requested',
          entityType: 'attendance',
          entityId: attendance.id,
          outcome: 'success',
          before: { status: attendance.status },
          after: {
            correctionId,
            requestedStatus: input.requestedStatus,
            reason: input.reason,
            date: toIsoDate(attendance.attendance_date),
          },
          ...requestMeta(request),
        });
        await recordActivity(client, {
          schoolId,
          entityType: 'student',
          entityId: attendance.student_id,
          eventType: 'attendance.correction_requested',
          actorUserId: actor.userId,
          summary: `Correction requested for ${fullName(
            attendance.first_name,
            attendance.middle_name,
            attendance.last_name,
          )} on ${toIsoDate(attendance.attendance_date)}: ${labelStatus(
            attendance.status,
          )} → ${labelStatus(input.requestedStatus)}`,
        });

        return loadCorrection(client, schoolId, correctionId);
      });

      return reply.status(201).send(correction);
    },
  );

  app.post(
    '/api/schools/:schoolId/attendance/corrections/:id/review',
    { preHandler: requirePermission('attendance.correction.approve') },
    async (request) => {
      const { schoolId, id } = parseInput(correctionParams, request.params);
      const actor = getActor(request);
      const input = parseInput(attendanceReviewInput, request.body);

      return withTransaction(async (client) => {
        const locked = await client.query<{
          id: string;
          attendance_id: string;
          requested_status: AttendanceStatus;
          status: 'pending' | 'approved' | 'rejected';
          requested_by: string;
        }>(
          `SELECT id, attendance_id, requested_status, status, requested_by
           FROM attendance_corrections
           WHERE school_id = $1 AND id = $2
           FOR UPDATE`,
          [schoolId, id],
        );
        const correction = locked.rows[0];
        if (!correction) throw notFound('Correction not found');

        const attendance = await loadAttendanceContext(
          client,
          schoolId,
          correction.attendance_id,
          true,
        );
        if (!attendance || !canAccessSection(actor, attendance.section_id)) {
          throw notFound('Correction not found');
        }
        if (correction.status !== 'pending') {
          throw conflict('This correction has already been reviewed', 'already_reviewed');
        }
        if (correction.requested_by === actor.userId) {
          // Persist the denial outside the transaction before rolling it back.
          await recordAudit(getPool(), {
            schoolId,
            actorUserId: actor.userId,
            action: 'attendance.correction_review_denied',
            entityType: 'attendance',
            entityId: attendance.id,
            outcome: 'denied',
            reason: 'self_approval',
            ...requestMeta(request),
          }).catch(() => undefined);
          throw forbidden('A different approver must review your own request');
        }

        if (input.decision === 'approve') {
          await client.query(
            `UPDATE student_attendance
             SET status = $3, source = 'correction', reviewed_by = $4
             WHERE school_id = $1 AND id = $2`,
            [schoolId, attendance.id, correction.requested_status, actor.userId],
          );
        }

        await client.query(
          `UPDATE attendance_corrections
           SET status = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5
           WHERE school_id = $1 AND id = $2`,
          [
            schoolId,
            id,
            input.decision === 'approve' ? 'approved' : 'rejected',
            actor.userId,
            input.note ?? null,
          ],
        );

        const nextStatus =
          input.decision === 'approve' ? correction.requested_status : attendance.status;
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action:
            input.decision === 'approve'
              ? 'attendance.correction_approved'
              : 'attendance.correction_rejected',
          entityType: 'attendance',
          entityId: attendance.id,
          outcome: 'success',
          before: { status: attendance.status },
          after: {
            status: nextStatus,
            correctionId: id,
            decision: input.decision,
            note: input.note ?? null,
          },
          ...requestMeta(request),
        });
        await recordActivity(client, {
          schoolId,
          entityType: 'student',
          entityId: attendance.student_id,
          eventType:
            input.decision === 'approve'
              ? 'attendance.correction_approved'
              : 'attendance.correction_rejected',
          actorUserId: actor.userId,
          summary:
            input.decision === 'approve'
              ? `Attendance for ${fullName(
                  attendance.first_name,
                  attendance.middle_name,
                  attendance.last_name,
                )} on ${toIsoDate(attendance.attendance_date)} corrected from ${labelStatus(
                  attendance.status,
                )} to ${labelStatus(correction.requested_status)}`
              : `Attendance correction for ${fullName(
                  attendance.first_name,
                  attendance.middle_name,
                  attendance.last_name,
                )} on ${toIsoDate(attendance.attendance_date)} rejected`,
        });

        return loadCorrection(client, schoolId, id);
      });
    },
  );
}

/* --------------------------------- loading -------------------------------- */

interface SectionRow {
  id: string;
  class_id: string;
  class_name: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
  academic_year_id: string;
  academic_year_name: string;
  starts_on: Date | string;
  ends_on: Date | string;
}

interface AttendanceContextRow {
  id: string;
  status: AttendanceStatus;
  attendance_date: Date | string;
  student_id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string | null;
  section_id: string;
  class_name: string;
  section_name: string;
}

interface RegisterRow {
  student_id: string;
  admission_number: string;
  first_name: string;
  middle_name: string | null;
  last_name: string | null;
  attendance_id: string | null;
  status: AttendanceStatus | null;
  note: string | null;
  source: string | null;
  recorded_by_name: string | null;
  correction_id: string | null;
  requested_status: AttendanceStatus | null;
  correction_reason: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  requested_at: Date | null;
}

interface CorrectionRow {
  id: string;
  attendance_id: string;
  student_id: string;
  admission_number: string;
  first_name: string;
  middle_name: string | null;
  last_name: string | null;
  section_id: string;
  class_name: string;
  section_name: string;
  attendance_date: Date | string;
  current_status: AttendanceStatus;
  requested_status: AttendanceStatus;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_by: string;
  requested_by_name: string | null;
  requested_at: Date;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
}

async function loadSection(
  client: pg.PoolClient,
  schoolId: string,
  sectionId: string,
): Promise<SectionRow | null> {
  const { rows } = await client.query<SectionRow>(
    `SELECT sec.id, sec.class_id, c.name AS class_name, sec.code, sec.name, sec.status,
            sec.academic_year_id, ay.name AS academic_year_name,
            ay.starts_on, ay.ends_on
     FROM sections sec
     JOIN classes c ON c.id = sec.class_id AND c.school_id = sec.school_id
     JOIN academic_years ay ON ay.id = sec.academic_year_id AND ay.school_id = sec.school_id
     WHERE sec.school_id = $1 AND sec.id = $2`,
    [schoolId, sectionId],
  );
  return rows[0] ?? null;
}

async function loadAttendanceContext(
  client: pg.PoolClient,
  schoolId: string,
  attendanceId: string,
  lock: boolean,
): Promise<AttendanceContextRow | null> {
  const { rows } = await client.query<AttendanceContextRow>(
    `SELECT a.id, a.status, a.attendance_date, a.student_id,
            st.first_name, st.middle_name, st.last_name,
            e.section_id, c.name AS class_name, sec.name AS section_name
     FROM student_attendance a
     JOIN students st ON st.id = a.student_id AND st.school_id = a.school_id
     JOIN enrollments e ON e.id = a.enrollment_id AND e.school_id = a.school_id
     JOIN sections sec ON sec.id = e.section_id AND sec.school_id = e.school_id
     JOIN classes c ON c.id = sec.class_id AND c.school_id = sec.school_id
     WHERE a.school_id = $1 AND a.id = $2
     ${lock ? 'FOR UPDATE OF a' : ''}`,
    [schoolId, attendanceId],
  );
  return rows[0] ?? null;
}

async function buildRegister(
  client: pg.PoolClient,
  actor: ActorContext,
  section: SectionRow,
  date: string,
): Promise<AttendanceRegister> {
  const today = todayInTimeZone(actor.school.timezone);
  const startsOn = toIsoDate(section.starts_on);
  const endsOn = toIsoDate(section.ends_on);
  const isFuture = date > today;
  const isWithinYear = date >= startsOn && date <= endsOn;
  const canRecord =
    actor.permissions.has('attendance.student.record') &&
    section.status === 'active' &&
    isWithinYear &&
    !isFuture;

  const { rows } = await client.query<RegisterRow>(
    `SELECT st.id AS student_id, st.admission_number,
            st.first_name, st.middle_name, st.last_name,
            a.id AS attendance_id, a.status, a.note, a.source,
            ru.display_name AS recorded_by_name,
            ac.id AS correction_id, ac.requested_status,
            ac.reason AS correction_reason, ac.requested_by,
            cu.display_name AS requested_by_name, ac.requested_at
     FROM enrollments e
     JOIN students st ON st.id = e.student_id AND st.school_id = e.school_id
     LEFT JOIN student_attendance a
       ON a.enrollment_id = e.id AND a.attendance_date = $3::date
     LEFT JOIN users ru ON ru.id = a.recorded_by
     LEFT JOIN attendance_corrections ac
       ON ac.attendance_id = a.id AND ac.status = 'pending'
     LEFT JOIN users cu ON cu.id = ac.requested_by
     WHERE e.school_id = $1 AND e.section_id = $2
       AND e.enrollment_status = 'active'
       AND e.starts_on <= $3::date
       AND (e.ends_on IS NULL OR e.ends_on >= $3::date)
     ORDER BY st.first_name, st.last_name, st.admission_number`,
    [actor.schoolId, section.id, date],
  );

  const registerRows: AttendanceRegisterRow[] = rows.map((row) => ({
    studentId: row.student_id,
    admissionNumber: row.admission_number,
    fullName: fullName(row.first_name, row.middle_name, row.last_name),
    attendanceId: row.attendance_id,
    status: row.status,
    note: row.note,
    source: row.source,
    recordedByName: row.recorded_by_name,
    pendingCorrection:
      row.correction_id && row.requested_status && row.requested_by && row.requested_at
        ? {
            id: row.correction_id,
            requestedStatus: row.requested_status,
            reason: row.correction_reason ?? '',
            requestedById: row.requested_by,
            requestedByName: row.requested_by_name,
            requestedAt: row.requested_at.toISOString(),
          }
        : null,
  }));

  const summary = {
    total: registerRows.length,
    marked: 0,
    unmarked: 0,
    present: 0,
    absent: 0,
    late: 0,
    halfDay: 0,
    excused: 0,
  };
  for (const row of registerRows) {
    if (!row.status) {
      summary.unmarked += 1;
      continue;
    }
    summary.marked += 1;
    if (row.status === 'present') summary.present += 1;
    else if (row.status === 'absent') summary.absent += 1;
    else if (row.status === 'late') summary.late += 1;
    else if (row.status === 'half_day') summary.halfDay += 1;
    else if (row.status === 'excused') summary.excused += 1;
  }

  const responseSection: AttendanceSectionSummary = {
    id: section.id,
    classId: section.class_id,
    className: section.class_name,
    code: section.code,
    name: section.name,
    academicYearId: section.academic_year_id,
    academicYearName: section.academic_year_name,
    startsOn,
    endsOn,
    status: section.status,
  };

  return {
    section: responseSection,
    date,
    today,
    isFuture,
    isWithinYear,
    canRecord,
    summary,
    rows: registerRows,
  };
}

const correctionSelect = `
  SELECT c.id, c.attendance_id, a.student_id, st.admission_number,
         st.first_name, st.middle_name, st.last_name,
         e.section_id, c2.name AS class_name, sec.name AS section_name,
         a.attendance_date, a.status AS current_status,
         c.requested_status, c.reason, c.status,
         c.requested_by, ru.display_name AS requested_by_name, c.requested_at,
         c.reviewed_by, vu.display_name AS reviewed_by_name, c.reviewed_at, c.review_note
  FROM attendance_corrections c
  JOIN student_attendance a ON a.id = c.attendance_id AND a.school_id = c.school_id
  JOIN students st ON st.id = a.student_id AND st.school_id = a.school_id
  JOIN enrollments e ON e.id = a.enrollment_id AND e.school_id = a.school_id
  JOIN sections sec ON sec.id = e.section_id AND sec.school_id = e.school_id
  JOIN classes c2 ON c2.id = sec.class_id AND c2.school_id = sec.school_id
  JOIN users ru ON ru.id = c.requested_by
  LEFT JOIN users vu ON vu.id = c.reviewed_by`;

async function loadCorrection(
  client: pg.PoolClient,
  schoolId: string,
  correctionId: string,
): Promise<AttendanceCorrection> {
  const { rows } = await client.query<CorrectionRow>(
    `${correctionSelect}
     WHERE c.school_id = $1 AND c.id = $2`,
    [schoolId, correctionId],
  );
  const row = rows[0];
  if (!row) throw notFound('Correction not found');
  return mapCorrection(row);
}

function mapCorrection(row: CorrectionRow): AttendanceCorrection {
  return {
    id: row.id,
    attendanceId: row.attendance_id,
    studentId: row.student_id,
    studentName: fullName(row.first_name, row.middle_name, row.last_name),
    admissionNumber: row.admission_number,
    sectionId: row.section_id,
    className: row.class_name,
    sectionName: row.section_name,
    attendanceDate: toIsoDate(row.attendance_date),
    currentStatus: row.current_status,
    requestedStatus: row.requested_status,
    reason: row.reason,
    status: row.status,
    requestedById: row.requested_by,
    requestedByName: row.requested_by_name,
    requestedAt: row.requested_at.toISOString(),
    reviewedById: row.reviewed_by,
    reviewedByName: row.reviewed_by_name,
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
    reviewNote: row.review_note,
  };
}

function assertDateRecordable(
  section: SectionRow,
  date: string,
  actor: ActorContext,
): void {
  if (section.status !== 'active') {
    throw badRequest('This section is inactive and cannot take attendance', {
      sectionId: ['Section is inactive'],
    });
  }
  const startsOn = toIsoDate(section.starts_on);
  const endsOn = toIsoDate(section.ends_on);
  if (date < startsOn || date > endsOn) {
    throw badRequest('The selected date is outside the section academic year', {
      date: [`Use a date between ${startsOn} and ${endsOn}`],
    });
  }
  if (date > todayInTimeZone(actor.school.timezone)) {
    throw badRequest('Attendance cannot be recorded for a future date', {
      date: ['Choose today or an earlier date'],
    });
  }
}

function labelStatus(status: string): string {
  return status.replaceAll('_', ' ');
}
