import {
  holidayInput,
  leaveTypeInput,
  uuid,
  type HolidayRecord,
  type LeaveBalanceRecord,
  type LeaveTypeRecord,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { fullName } from '@erp/core';
import { getActor, requireAnyPermission, requirePermission, requestMeta } from '../auth/guards';
import type { ActorContext } from '../auth/session';
import { getPool, withTransaction } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, notFound, parseInput } from '../lib/errors';
import { toIsoDate, toNumber } from '../lib/format';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const balanceQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2200).optional(),
  staffId: uuid.optional(),
});
const holidayQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2200).optional(),
});

/**
 * Leave configuration and derived balances.
 *
 * A leave type's quota is annual. Balances count approved and pending requests
 * that start in the selected calendar year. There is no carry-forward in this
 * build; that is a documented policy decision (CLIENT_DECISIONS.md).
 */
export async function registerLeaveConfigRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------- leave types ------------------------------ */

  app.get(
    '/api/schools/:schoolId/leave/types',
    { preHandler: requireAnyPermission('hr.leave.request', 'hr.leave.approve', 'hr.leave.configure') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const { rows } = await getPool().query<LeaveTypeRow>(
        `SELECT id, code, name, annual_quota_days, paid, active
         FROM leave_types
         WHERE school_id = $1 ${canConfigure(actor) ? '' : 'AND active'}
         ORDER BY name, code`,
        [schoolId],
      );
      return { items: rows.map(mapLeaveType) };
    },
  );

  app.post(
    '/api/schools/:schoolId/leave/types',
    { preHandler: requirePermission('hr.leave.configure') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(leaveTypeInput, request.body);
      const created = await withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO leave_types (school_id, code, name, annual_quota_days, paid, active)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [schoolId, input.code, input.name, input.annualQuotaDays, input.paid, input.active],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.leave_type_created',
          entityType: 'leave_type',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: input,
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });
      const { rows } = await getPool().query<LeaveTypeRow>(
        `SELECT id, code, name, annual_quota_days, paid, active
         FROM leave_types WHERE school_id = $1 AND id = $2`,
        [schoolId, created],
      );
      return reply.status(201).send(mapLeaveType(rows[0]!));
    },
  );

  app.patch(
    '/api/schools/:schoolId/leave/types/:id',
    { preHandler: requirePermission('hr.leave.configure') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(leaveTypeInput.partial(), request.body);
      await withTransaction(async (client) => {
        const existing = await client.query<LeaveTypeRow>(
          `SELECT id, code, name, annual_quota_days, paid, active
           FROM leave_types WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Leave type not found');
        await client.query(
          `UPDATE leave_types
           SET code = $3, name = $4, annual_quota_days = $5, paid = $6, active = $7
           WHERE school_id = $1 AND id = $2`,
          [
            schoolId,
            id,
            input.code ?? row.code,
            input.name ?? row.name,
            input.annualQuotaDays ?? row.annual_quota_days,
            input.paid ?? row.paid,
            input.active ?? row.active,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.leave_type_updated',
          entityType: 'leave_type',
          entityId: id,
          outcome: 'success',
          before: mapLeaveType(row),
          after: input,
          ...requestMeta(request),
        });
      });
      const { rows } = await getPool().query<LeaveTypeRow>(
        `SELECT id, code, name, annual_quota_days, paid, active
         FROM leave_types WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      );
      return mapLeaveType(rows[0]!);
    },
  );

  /* --------------------------------- holidays -------------------------------- */

  app.get(
    '/api/schools/:schoolId/holidays',
    { preHandler: requireAnyPermission('hr.leave.request', 'hr.leave.approve', 'academic.structure.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(holidayQuery, request.query);
      const year = query.year ?? new Date().getUTCFullYear();
      const { rows } = await getPool().query<HolidayRow>(
        `SELECT id, name, holiday_on, academic_year_id, notes
         FROM holidays
         WHERE school_id = $1 AND holiday_on >= $2::date AND holiday_on < $3::date
         ORDER BY holiday_on, name`,
        [schoolId, `${year}-01-01`, `${year + 1}-01-01`],
      );
      return { items: rows.map(mapHoliday) };
    },
  );

  app.post(
    '/api/schools/:schoolId/holidays',
    { preHandler: requirePermission('hr.leave.configure') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(holidayInput, request.body);
      const created = await withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO holidays (school_id, name, holiday_on, academic_year_id, notes)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [schoolId, input.name, input.holidayOn, input.academicYearId ?? null, input.notes ?? null],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.holiday_created',
          entityType: 'holiday',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: input,
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });
      const { rows } = await getPool().query<HolidayRow>(
        `SELECT id, name, holiday_on, academic_year_id, notes
         FROM holidays WHERE school_id = $1 AND id = $2`,
        [schoolId, created],
      );
      return reply.status(201).send(mapHoliday(rows[0]!));
    },
  );

  app.delete(
    '/api/schools/:schoolId/holidays/:id',
    { preHandler: requirePermission('hr.leave.configure') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      await withTransaction(async (client) => {
        const { rows } = await client.query<{ name: string; holiday_on: string }>(
          `DELETE FROM holidays WHERE school_id = $1 AND id = $2
           RETURNING name, holiday_on`,
          [schoolId, id],
        );
        if (!rows[0]) throw notFound('Holiday not found');
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.holiday_deleted',
          entityType: 'holiday',
          entityId: id,
          outcome: 'success',
          before: rows[0],
          ...requestMeta(request),
        });
      });
      return reply.status(204).send();
    },
  );

  /* --------------------------------- balances -------------------------------- */

  app.get(
    '/api/schools/:schoolId/leave/balances',
    { preHandler: requireAnyPermission('hr.leave.request', 'hr.leave.approve') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const query = parseInput(balanceQuery, request.query);
      const year = query.year ?? new Date().getUTCFullYear();

      const params: unknown[] = [schoolId, `${year}-01-01`, `${year}-12-31`];
      const conditions = ["s.school_id = $1", "s.status IN ('active', 'on_leave')"];
      if (!canConfigure(actor) && !actor.permissions.has('hr.leave.approve')) {
        params.push(actor.userId);
        conditions.push(`s.user_id = $${params.length}`);
      } else if (query.staffId) {
        params.push(query.staffId);
        conditions.push(`s.id = $${params.length}`);
      }

      const { rows } = await getPool().query<BalanceRow>(
        `SELECT s.id AS staff_id, s.first_name, s.last_name,
                lt.code AS leave_type,
                lt.annual_quota_days,
                COALESCE((
                  SELECT sum(l.ends_on - l.starts_on + 1) FROM leave_requests l
                  WHERE l.school_id = s.school_id AND l.staff_id = s.id
                    AND l.status = 'approved' AND l.leave_type = lt.code
                    AND l.starts_on BETWEEN $2::date AND $3::date
                ), 0) AS approved_days,
                COALESCE((
                  SELECT sum(l.ends_on - l.starts_on + 1) FROM leave_requests l
                  WHERE l.school_id = s.school_id AND l.staff_id = s.id
                    AND l.status = 'pending' AND l.leave_type = lt.code
                    AND l.starts_on BETWEEN $2::date AND $3::date
                ), 0) AS pending_days
         FROM staff s
         CROSS JOIN leave_types lt
         WHERE ${conditions.join(' AND ')}
           AND lt.school_id = s.school_id AND lt.active
         ORDER BY s.first_name, s.last_name, lt.name`,
        params,
      );

      const items: LeaveBalanceRecord[] = rows.map((row) => {
        const quotaDays = toNumber(row.annual_quota_days);
        const approvedDays = toNumber(row.approved_days);
        return {
          staffId: row.staff_id,
          staffName: fullName(row.first_name, null, row.last_name),
          leaveType: row.leave_type,
          quotaDays,
          approvedDays,
          pendingDays: toNumber(row.pending_days),
          remainingDays: quotaDays > 0 ? Math.max(0, quotaDays - approvedDays) : null,
        };
      });
      return { year, items };
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

function canConfigure(actor: ActorContext): boolean {
  return actor.permissions.has('hr.leave.configure');
}

interface LeaveTypeRow {
  id: string;
  code: string;
  name: string;
  annual_quota_days: string;
  paid: boolean;
  active: boolean;
}

function mapLeaveType(row: LeaveTypeRow): LeaveTypeRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    annualQuotaDays: toNumber(row.annual_quota_days),
    paid: row.paid,
    active: row.active,
  };
}

interface HolidayRow {
  id: string;
  name: string;
  holiday_on: string;
  academic_year_id: string | null;
  notes: string | null;
}

function mapHoliday(row: HolidayRow): HolidayRecord {
  return {
    id: row.id,
    name: row.name,
    holidayOn: toIsoDate(row.holiday_on),
    academicYearId: row.academic_year_id,
    notes: row.notes,
  };
}

interface BalanceRow {
  staff_id: string;
  first_name: string;
  last_name: string | null;
  leave_type: string;
  annual_quota_days: string;
  approved_days: string;
  pending_days: string;
}

export async function ensureLeaveType(
  client: pg.PoolClient,
  schoolId: string,
  code: string,
): Promise<void> {
  const { rows } = await client.query<{ code: string; active: boolean }>(
    'SELECT code, active FROM leave_types WHERE school_id = $1',
    [schoolId],
  );
  // Until a school configures leave types, the free-text code is accepted so
  // existing records keep working. Once configured, only active codes are valid.
  if (rows.length === 0) return;
  const match = rows.find((row) => row.code === code.trim().toLowerCase());
  if (!match) {
    throw badRequest('Choose a configured leave type', {
      leaveType: [`Use one of: ${rows.map((row) => row.code).sort().join(', ')}`],
    });
  }
  if (!match.active) {
    throw badRequest('That leave type is inactive', { leaveType: ['Choose another leave type'] });
  }
}
