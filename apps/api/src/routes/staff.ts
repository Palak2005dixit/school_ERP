import { fullName } from '@erp/core';
import {
  leaveInput,
  leaveReviewInput,
  salaryInput,
  staffInput,
  staffUpdate,
  uuid,
  type LeaveRecord,
  type SalaryRecord,
  type StaffRecord,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { getActor, requireAnyPermission, requirePermission, requestMeta } from '../auth/guards';
import type { ActorContext } from '../auth/session';
import { getPool, withTransaction } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound, parseInput } from '../lib/errors';
import { assertDateRange, toIsoDate, toIsoDateTime, toNumber } from '../lib/format';
import { ensureLeaveType } from './leaveConfig';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const staffQuery = z.object({ status: z.enum(['active', 'on_leave', 'inactive', 'left']).optional() });
const leaveQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
});

/**
 * Staff records, gated salary data and leave workflow.
 *
 * Salary lives in its own table and is only returned by endpoints guarded by
 * `hr.employee.salary.view_sensitive`; the ordinary staff list never joins it.
 * A leave request is either for the actor's own staff record or, for approvers,
 * for a chosen staff member. Nobody may approve their own request.
 */
export async function registerStaffRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------- staff -------------------------------- */

  app.get(
    '/api/schools/:schoolId/staff',
    { preHandler: requirePermission('hr.employee.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(staffQuery, request.query);
      const params: unknown[] = [schoolId];
      let filter = '';
      if (query.status) {
        params.push(query.status);
        filter = `AND s.status = $${params.length}`;
      }

      const { rows } = await getPool().query<{
        id: string;
        user_id: string | null;
        employee_number: string;
        first_name: string;
        last_name: string | null;
        email: string | null;
        phone: string | null;
        designation: string;
        department: string | null;
        joined_on: string | null;
        status: StaffRecord['status'];
        has_salary: boolean;
        pending_leave: string;
      }>(
        `SELECT s.id, s.user_id, s.employee_number, s.first_name, s.last_name,
                COALESCE(s.email, u.email) AS email, s.phone, s.designation, s.department,
                s.joined_on, s.status,
                EXISTS (SELECT 1 FROM staff_salaries sal
                        WHERE sal.school_id = s.school_id AND sal.staff_id = s.id) AS has_salary,
                (SELECT count(*) FROM leave_requests l
                 WHERE l.school_id = s.school_id AND l.staff_id = s.id
                   AND l.status = 'pending')::text AS pending_leave
         FROM staff s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.school_id = $1 ${filter}
         ORDER BY s.first_name, s.last_name, s.employee_number`,
        params,
      );

      const items: StaffRecord[] = rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        employeeNumber: row.employee_number,
        firstName: row.first_name,
        lastName: row.last_name,
        fullName: fullName(row.first_name, null, row.last_name),
        email: row.email,
        phone: row.phone,
        designation: row.designation,
        department: row.department,
        joinedOn: row.joined_on ? toIsoDate(row.joined_on) : null,
        status: row.status,
        hasSalary: row.has_salary,
        pendingLeave: toNumber(row.pending_leave),
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/staff',
    { preHandler: requirePermission('hr.employee.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(staffInput, request.body);

      const created = await withTransaction(async (client) => {
        if (input.userId) await assertStaffUser(client, schoolId, input.userId);

        const employeeNumber =
          input.employeeNumber ?? (await nextEmployeeNumber(client, schoolId));

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO staff
             (school_id, user_id, employee_number, first_name, last_name, email, phone,
              designation, department, joined_on, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            schoolId,
            input.userId ?? null,
            employeeNumber,
            input.firstName,
            input.lastName ?? null,
            input.email ?? null,
            input.phone ?? null,
            input.designation,
            input.department ?? null,
            input.joinedOn ?? null,
            input.status,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.employee_created',
          entityType: 'staff',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: { ...input, employeeNumber },
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });

      const { rows } = await getPool().query<StaffRow>(
        `${staffSelect} WHERE s.school_id = $1 AND s.id = $2`,
        [schoolId, created],
      );
      return reply.status(201).send(mapStaff(rows[0]!));
    },
  );

  app.patch(
    '/api/schools/:schoolId/staff/:id',
    { preHandler: requirePermission('hr.employee.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(staffUpdate, request.body);

      await withTransaction(async (client) => {
        const existing = await client.query<{
          id: string;
          user_id: string | null;
          employee_number: string;
          first_name: string;
          last_name: string | null;
          email: string | null;
          phone: string | null;
          designation: string;
          department: string | null;
          joined_on: string | null;
          status: StaffRecord['status'];
        }>(
          `SELECT id, user_id, employee_number, first_name, last_name, email, phone,
                  designation, department, joined_on, status
           FROM staff WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Staff member not found');
        if (input.userId) await assertStaffUser(client, schoolId, input.userId);

        await client.query(
          `UPDATE staff
           SET user_id = $3, employee_number = $4, first_name = $5, last_name = $6,
               email = $7, phone = $8, designation = $9, department = $10,
               joined_on = $11, status = $12
           WHERE school_id = $1 AND id = $2`,
          [
            schoolId,
            id,
            input.userId === undefined ? row.user_id : input.userId,
            input.employeeNumber ?? row.employee_number,
            input.firstName ?? row.first_name,
            input.lastName === undefined ? row.last_name : input.lastName,
            input.email === undefined ? row.email : input.email,
            input.phone === undefined ? row.phone : input.phone,
            input.designation ?? row.designation,
            input.department === undefined ? row.department : input.department,
            input.joinedOn === undefined ? row.joined_on : input.joinedOn,
            input.status ?? row.status,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.employee_updated',
          entityType: 'staff',
          entityId: id,
          outcome: 'success',
          before: row,
          after: input,
          ...requestMeta(request),
        });
      });

      const { rows } = await getPool().query<StaffRow>(
        `${staffSelect} WHERE s.school_id = $1 AND s.id = $2`,
        [schoolId, id],
      );
      return mapStaff(rows[0]!);
    },
  );

  /* --------------------------------- salaries ------------------------------- */

  app.get(
    '/api/schools/:schoolId/staff/salaries',
    { preHandler: requirePermission('hr.employee.salary.view_sensitive') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<SalaryRow>(
        `SELECT sal.staff_id, s.first_name, s.last_name, sal.amount, sal.currency,
                sal.effective_from, sal.notes, u.display_name AS updated_by_name, sal.updated_at
         FROM staff_salaries sal
         JOIN staff s ON s.id = sal.staff_id AND s.school_id = sal.school_id
         LEFT JOIN users u ON u.id = sal.updated_by
         WHERE sal.school_id = $1
         ORDER BY s.first_name, s.last_name`,
        [schoolId],
      );
      return { items: rows.map(mapSalary) };
    },
  );

  app.put(
    '/api/schools/:schoolId/staff/:id/salary',
    { preHandler: requirePermission('hr.employee.salary.view_sensitive') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(salaryInput, request.body);

      await withTransaction(async (client) => {
        const staff = await client.query(
          'SELECT 1 FROM staff WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        if (staff.rowCount === 0) throw notFound('Staff member not found');

        await client.query(
          `INSERT INTO staff_salaries
             (school_id, staff_id, amount, currency, effective_from, notes, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (school_id, staff_id) DO UPDATE
             SET amount = EXCLUDED.amount,
                 currency = EXCLUDED.currency,
                 effective_from = EXCLUDED.effective_from,
                 notes = EXCLUDED.notes,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = now()`,
          [
            schoolId,
            id,
            input.amount,
            input.currency,
            input.effectiveFrom,
            input.notes ?? null,
            actor.userId,
          ],
        );
        // The amount deliberately stays out of the audit trail: auditors have
        // read access to audit events but not to salary data.
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.salary_updated',
          entityType: 'staff',
          entityId: id,
          outcome: 'success',
          after: { effectiveFrom: input.effectiveFrom, currency: input.currency },
          ...requestMeta(request),
        });
      });

      const { rows } = await getPool().query<SalaryRow>(
        `SELECT sal.staff_id, s.first_name, s.last_name, sal.amount, sal.currency,
                sal.effective_from, sal.notes, u.display_name AS updated_by_name, sal.updated_at
         FROM staff_salaries sal
         JOIN staff s ON s.id = sal.staff_id AND s.school_id = sal.school_id
         LEFT JOIN users u ON u.id = sal.updated_by
         WHERE sal.school_id = $1 AND sal.staff_id = $2`,
        [schoolId, id],
      );
      return mapSalary(rows[0]!);
    },
  );

  /* ---------------------------------- leave --------------------------------- */

  app.get(
    '/api/schools/:schoolId/leave',
    { preHandler: requireAnyPermission('hr.leave.request', 'hr.leave.approve') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const query = parseInput(leaveQuery, request.query);

      const params: unknown[] = [schoolId];
      const conditions = ['l.school_id = $1'];
      if (!canApproveLeave(actor)) {
        params.push(actor.userId);
        conditions.push(
          `s.user_id = $${params.length}`,
        );
      }
      if (query.status) {
        params.push(query.status);
        conditions.push(`l.status = $${params.length}`);
      }

      const { rows } = await getPool().query<LeaveRow>(
        `${leaveSelect} WHERE ${conditions.join(' AND ')}
         ORDER BY (l.status = 'pending') DESC, l.starts_on DESC`,
        params,
      );
      return { items: rows.map(mapLeave) };
    },
  );

  app.post(
    '/api/schools/:schoolId/leave',
    { preHandler: requirePermission('hr.leave.request') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(leaveInput, request.body);
      assertDateRange(input.startsOn, input.endsOn);
      const days = countDays(input.startsOn, input.endsOn);
      if (days > 90) {
        throw badRequest('A single leave request cannot exceed 90 days', {
          endsOn: ['Shorten the leave period'],
        });
      }

      const created = await withTransaction(async (client) => {
        const staffId =
          input.staffId ?? (await staffIdForUser(client, schoolId, actor.userId));
        if (!staffId) {
          throw badRequest('No staff record is linked to your account', {
            staffId: ['Ask an administrator to link your staff record first'],
          });
        }
        if (input.staffId && !canApproveLeave(actor)) {
          const own = await client.query<{ id: string }>(
            'SELECT id FROM staff WHERE school_id = $1 AND id = $2 AND user_id = $3',
            [schoolId, input.staffId, actor.userId],
          );
          if (!own.rows[0]) throw forbidden('You can only request leave for your own staff record');
        }
        const staff = await client.query<{ id: string; status: string }>(
          'SELECT id, status FROM staff WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, staffId],
        );
        if (!staff.rows[0]) throw notFound('Staff member not found');
        if (staff.rows[0].status === 'left' || staff.rows[0].status === 'inactive') {
          throw badRequest('Leave cannot be requested for inactive staff');
        }
        await ensureLeaveType(client, schoolId, input.leaveType);

        const overlap = await client.query<{ id: string }>(
          `SELECT id FROM leave_requests
           WHERE school_id = $1 AND staff_id = $2
             AND status IN ('pending', 'approved')
             AND daterange(starts_on, ends_on, '[]') && daterange($3::date, $4::date, '[]')
           LIMIT 1`,
          [schoolId, staffId, input.startsOn, input.endsOn],
        );
        if (overlap.rows[0]) {
          throw conflict(
            'This staff member already has pending or approved leave in that period',
            'leave_overlap',
          );
        }

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO leave_requests
             (school_id, staff_id, leave_type, starts_on, ends_on, reason, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [
            schoolId,
            staffId,
            input.leaveType.trim().toLowerCase(),
            input.startsOn,
            input.endsOn,
            input.reason,
            actor.userId,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.leave_requested',
          entityType: 'leave_request',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: { ...input, staffId, days },
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });

      const { rows } = await getPool().query<LeaveRow>(
        `${leaveSelect} WHERE l.school_id = $1 AND l.id = $2`,
        [schoolId, created],
      );
      return reply.status(201).send(mapLeave(rows[0]!));
    },
  );

  app.post(
    '/api/schools/:schoolId/leave/:id/review',
    { preHandler: requirePermission('hr.leave.approve') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(leaveReviewInput, request.body);

      await withTransaction(async (client) => {
        const existing = await client.query<{
          id: string;
          status: LeaveRecord['status'];
          requested_by: string;
          staff_id: string;
        }>(
          `SELECT id, status, requested_by, staff_id FROM leave_requests
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Leave request not found');
        if (row.status !== 'pending') {
          throw conflict('This leave request has already been reviewed', 'already_reviewed');
        }
        if (row.requested_by === actor.userId) {
          throw conflict('A different approver must review your own leave request', 'self_approval');
        }

        await client.query(
          `UPDATE leave_requests
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
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action:
            input.decision === 'approve' ? 'hr.leave_approved' : 'hr.leave_rejected',
          entityType: 'leave_request',
          entityId: id,
          outcome: 'success',
          after: { decision: input.decision, note: input.note ?? null },
          ...requestMeta(request),
        });
      });

      const { rows } = await getPool().query<LeaveRow>(
        `${leaveSelect} WHERE l.school_id = $1 AND l.id = $2`,
        [schoolId, id],
      );
      return mapLeave(rows[0]!);
    },
  );

  app.post(
    '/api/schools/:schoolId/leave/:id/cancel',
    { preHandler: requirePermission('hr.leave.request') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);

      await withTransaction(async (client) => {
        const existing = await client.query<{
          id: string;
          status: LeaveRecord['status'];
          requested_by: string;
        }>(
          'SELECT id, status, requested_by FROM leave_requests WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Leave request not found');
        if (row.requested_by !== actor.userId && !canApproveLeave(actor)) {
          throw forbidden('You can only cancel your own leave requests');
        }
        if (row.status !== 'pending') {
          throw conflict('Only pending leave can be cancelled', 'not_pending');
        }

        await client.query(
          'UPDATE leave_requests SET status = $3 WHERE school_id = $1 AND id = $2',
          [schoolId, id, 'cancelled'],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.leave_cancelled',
          entityType: 'leave_request',
          entityId: id,
          outcome: 'success',
          ...requestMeta(request),
        });
      });

      return reply.status(204).send();
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

interface StaffRow {
  id: string;
  user_id: string | null;
  employee_number: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  designation: string;
  department: string | null;
  joined_on: string | null;
  status: StaffRecord['status'];
  has_salary: boolean;
  pending_leave: string;
}

const staffSelect = `
  SELECT s.id, s.user_id, s.employee_number, s.first_name, s.last_name,
         COALESCE(s.email, u.email) AS email, s.phone, s.designation, s.department,
         s.joined_on, s.status,
         EXISTS (SELECT 1 FROM staff_salaries sal
                 WHERE sal.school_id = s.school_id AND sal.staff_id = s.id) AS has_salary,
         (SELECT count(*) FROM leave_requests l
          WHERE l.school_id = s.school_id AND l.staff_id = s.id
            AND l.status = 'pending')::text AS pending_leave
  FROM staff s
  LEFT JOIN users u ON u.id = s.user_id`;

function mapStaff(row: StaffRow): StaffRecord {
  return {
    id: row.id,
    userId: row.user_id,
    employeeNumber: row.employee_number,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: fullName(row.first_name, null, row.last_name),
    email: row.email,
    phone: row.phone,
    designation: row.designation,
    department: row.department,
    joinedOn: row.joined_on ? toIsoDate(row.joined_on) : null,
    status: row.status,
    hasSalary: row.has_salary,
    pendingLeave: toNumber(row.pending_leave),
  };
}

interface SalaryRow {
  staff_id: string;
  first_name: string;
  last_name: string | null;
  amount: string;
  currency: string;
  effective_from: string;
  notes: string | null;
  updated_by_name: string | null;
  updated_at: Date;
}

function mapSalary(row: SalaryRow): SalaryRecord {
  return {
    staffId: row.staff_id,
    staffName: fullName(row.first_name, null, row.last_name),
    amount: toNumber(row.amount),
    currency: row.currency,
    effectiveFrom: toIsoDate(row.effective_from),
    notes: row.notes,
    updatedByName: row.updated_by_name,
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

interface LeaveRow {
  id: string;
  staff_id: string;
  first_name: string;
  last_name: string | null;
  leave_type: string;
  starts_on: string;
  ends_on: string;
  days: number;
  reason: string;
  status: LeaveRecord['status'];
  requested_by_name: string | null;
  requested_at: Date;
  reviewed_by_name: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
}

const leaveSelect = `
  SELECT l.id, l.staff_id, s.first_name, s.last_name, l.leave_type,
         l.starts_on, l.ends_on, (l.ends_on - l.starts_on + 1) AS days, l.reason, l.status,
         ru.display_name AS requested_by_name, l.requested_at,
         vu.display_name AS reviewed_by_name, l.reviewed_at, l.review_note
  FROM leave_requests l
  JOIN staff s ON s.id = l.staff_id AND s.school_id = l.school_id
  LEFT JOIN users ru ON ru.id = l.requested_by
  LEFT JOIN users vu ON vu.id = l.reviewed_by`;

function mapLeave(row: LeaveRow): LeaveRecord {
  return {
    id: row.id,
    staffId: row.staff_id,
    staffName: fullName(row.first_name, null, row.last_name),
    leaveType: row.leave_type,
    startsOn: toIsoDate(row.starts_on),
    endsOn: toIsoDate(row.ends_on),
    days: Number(row.days),
    reason: row.reason,
    status: row.status,
    requestedByName: row.requested_by_name,
    requestedAt: toIsoDateTime(row.requested_at),
    reviewedByName: row.reviewed_by_name,
    reviewedAt: row.reviewed_at ? toIsoDateTime(row.reviewed_at) : null,
    reviewNote: row.review_note,
  };
}

function canApproveLeave(actor: ActorContext): boolean {
  return actor.permissions.has('hr.leave.approve');
}

async function assertStaffUser(
  client: pg.PoolClient,
  schoolId: string,
  userId: string,
): Promise<void> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM user_role_assignments
     WHERE school_id = $1 AND user_id = $2 AND revoked_at IS NULL
       AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
     LIMIT 1`,
    [schoolId, userId],
  );
  if (rowCount === 0) {
    throw badRequest('That user has no active role in this school', {
      userId: ['Choose a user who belongs to this school'],
    });
  }
}

async function staffIdForUser(
  client: pg.PoolClient,
  schoolId: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM staff WHERE school_id = $1 AND user_id = $2',
    [schoolId, userId],
  );
  return rows[0]?.id ?? null;
}

async function nextEmployeeNumber(
  client: pg.PoolClient,
  schoolId: string,
): Promise<string> {
  const { rows } = await client.query<{ value: string }>(
    `INSERT INTO school_counters (school_id, name, value)
     VALUES ($1, 'employee_number', 1)
     ON CONFLICT (school_id, name)
     DO UPDATE SET value = school_counters.value + 1
     RETURNING value`,
    [schoolId],
  );
  return `EMP-${String(rows[0]!.value).padStart(4, '0')}`;
}

function countDays(startsOn: string, endsOn: string): number {
  const start = Date.parse(`${startsOn}T00:00:00Z`);
  const end = Date.parse(`${endsOn}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}
