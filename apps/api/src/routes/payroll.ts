import {
  payrollPayInput,
  payrollRunInput,
  uuid,
  type PayrollRunDetail,
  type PayrollRunSummary,
  type PayslipRecord,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { fullName } from '@erp/core';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, conflict, notFound, parseInput } from '../lib/errors';
import { toIsoDate, toIsoDateTime, toNumber } from '../lib/format';
import { idempotentRoute } from '../lib/idempotency';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const payslipParams = z.object({ schoolId: uuid, id: uuid, payslipId: uuid });
const payslipUpdate = z.object({
  deductions: z.coerce.number().min(0).max(99_999_999.99),
  notes: z.string().trim().max(500).optional(),
});

/**
 * Payroll. Amounts are read only by holders of the salary-sensitive
 * permission. Runs are generated from current staff salaries, approved by a
 * different user and paid in a separate audited step.
 */
export async function registerPayrollRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/schools/:schoolId/payroll',
    { preHandler: requirePermission('hr.employee.salary.view_sensitive') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<PayrollRow>(`${payrollSelect}
        WHERE r.school_id = $1
        GROUP BY r.id, cu.display_name, au.display_name
        ORDER BY r.period_start DESC`, [schoolId]);
      return { items: rows.map(mapPayroll) };
    },
  );

  app.get(
    '/api/schools/:schoolId/payroll/:id',
    { preHandler: requirePermission('hr.employee.salary.view_sensitive') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const run = await loadRun(getPool(), schoolId, id);
      const { rows } = await getPool().query<PayslipRow>(
        `SELECT p.id, p.staff_id, s.first_name, s.last_name, s.employee_number,
                p.gross_amount, p.deductions, p.net_amount, p.notes
         FROM payslips p
         JOIN staff s ON s.id = p.staff_id AND s.school_id = p.school_id
         WHERE p.school_id = $1 AND p.run_id = $2
         ORDER BY s.first_name, s.last_name`,
        [schoolId, id],
      );
      const detail: PayrollRunDetail = { ...run, payslips: rows.map(mapPayslip) };
      return detail;
    },
  );

  app.post(
    '/api/schools/:schoolId/payroll',
    { preHandler: requirePermission('hr.payroll.manage') },
    idempotentRoute('POST /payroll', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(payrollRunInput, request.body);
      if (input.periodEnd < input.periodStart) {
        throw badRequest('The period end must be on or after the start', {
          periodEnd: ['Choose a later date'],
        });
      }
      const days =
        (Date.parse(`${input.periodEnd}T00:00:00Z`) -
          Date.parse(`${input.periodStart}T00:00:00Z`)) /
        86_400_000;
      if (days > 92) {
        throw badRequest('A payroll run cannot span more than 92 days', {
          periodEnd: ['Shorten the period'],
        });
      }

      const created = await withTransaction(async (client) => {
        const duplicate = await client.query(
          `SELECT 1 FROM payroll_runs WHERE school_id = $1 AND period_start = $2 AND period_end = $3`,
          [schoolId, input.periodStart, input.periodEnd],
        );
        if (duplicate.rowCount) {
          throw conflict('A payroll run already exists for that period', 'duplicate_period');
        }

        const staff = await client.query<{
          staff_id: string;
          amount: string;
        }>(
          `SELECT s.id AS staff_id, sal.amount
           FROM staff s
           JOIN staff_salaries sal ON sal.school_id = s.school_id AND sal.staff_id = s.id
           WHERE s.school_id = $1 AND s.status IN ('active', 'on_leave')
           ORDER BY s.first_name, s.last_name`,
          [schoolId],
        );
        if (staff.rows.length === 0) {
          throw badRequest('No active staff have a salary recorded yet');
        }

        const deductionMap = new Map(
          (input.deductions ?? []).map((entry) => [entry.staffId, entry.amount]),
        );
        for (const deduction of input.deductions ?? []) {
          if (!staff.rows.some((row) => row.staff_id === deduction.staffId)) {
            throw badRequest('A deduction refers to staff outside this run', {
              deductions: ['Remove deductions for staff without a salary'],
            });
          }
        }

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO payroll_runs (school_id, period_start, period_end, notes, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [schoolId, input.periodStart, input.periodEnd, input.notes ?? null, actor.userId],
        );
        const runId = rows[0]!.id;

        for (const row of staff.rows) {
          const gross = toNumber(row.amount);
          const deductions = deductionMap.get(row.staff_id) ?? 0;
          if (deductions > gross) {
            throw badRequest('Deductions cannot exceed gross pay', {
              deductions: ['Lower the deduction for this staff member'],
            });
          }
          await client.query(
            `INSERT INTO payslips
               (school_id, run_id, staff_id, gross_amount, deductions, net_amount)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [schoolId, runId, row.staff_id, gross, deductions, gross - deductions],
          );
        }

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.payroll_run_created',
          entityType: 'payroll_run',
          entityId: runId,
          outcome: 'success',
          // Counts only: payroll amounts stay out of the audit trail.
          after: {
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            payslips: staff.rows.length,
          },
          ...requestMeta(request),
        });
        return runId;
      });

      return reply.status(201).send(await loadRun(getPool(), schoolId, created));
    }),
  );

  app.patch(
    '/api/schools/:schoolId/payroll/:id/payslips/:payslipId',
    { preHandler: requirePermission('hr.payroll.manage') },
    async (request) => {
      const { schoolId, id, payslipId } = parseInput(payslipParams, request.params);
      const actor = getActor(request);
      const input = parseInput(payslipUpdate, request.body);

      await withTransaction(async (client) => {
        const run = await client.query<{ status: string }>(
          'SELECT status FROM payroll_runs WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        if (!run.rows[0]) throw notFound('Payroll run not found');
        if (run.rows[0].status !== 'draft') {
          throw conflict('Only draft payroll can be edited', 'not_draft');
        }
        const payslip = await client.query<{ gross_amount: string }>(
          `SELECT gross_amount FROM payslips
           WHERE school_id = $1 AND run_id = $2 AND id = $3 FOR UPDATE`,
          [schoolId, id, payslipId],
        );
        if (!payslip.rows[0]) throw notFound('Payslip not found');
        const gross = toNumber(payslip.rows[0].gross_amount);
        if (input.deductions > gross) {
          throw badRequest('Deductions cannot exceed gross pay', {
            deductions: ['Lower the deduction'],
          });
        }
        await client.query(
          `UPDATE payslips SET deductions = $4, net_amount = $5, notes = $6
           WHERE school_id = $1 AND run_id = $2 AND id = $3`,
          [schoolId, id, payslipId, input.deductions, gross - input.deductions, input.notes ?? null],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.payslip_updated',
          entityType: 'payroll_run',
          entityId: id,
          outcome: 'success',
          after: { payslipId },
          ...requestMeta(request),
        });
      });

      const { rows } = await getPool().query<PayslipRow>(
        `SELECT p.id, p.staff_id, s.first_name, s.last_name, s.employee_number,
                p.gross_amount, p.deductions, p.net_amount, p.notes
         FROM payslips p
         JOIN staff s ON s.id = p.staff_id AND s.school_id = p.school_id
         WHERE p.school_id = $1 AND p.run_id = $2 AND p.id = $3`,
        [schoolId, id, payslipId],
      );
      return mapPayslip(rows[0]!);
    },
  );

  app.post(
    '/api/schools/:schoolId/payroll/:id/approve',
    { preHandler: requirePermission('hr.payroll.approve') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      await withTransaction(async (client) => {
        const existing = await client.query<{ status: string; created_by: string }>(
          'SELECT status, created_by FROM payroll_runs WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Payroll run not found');
        if (row.status !== 'draft') throw conflict('Only draft payroll can be approved', 'not_draft');
        if (row.created_by === actor.userId) {
          throw conflict('A different user must approve this payroll run', 'self_approval');
        }
        await client.query(
          `UPDATE payroll_runs
           SET status = 'approved', approved_by = $3, approved_at = now()
           WHERE school_id = $1 AND id = $2`,
          [schoolId, id, actor.userId],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.payroll_run_approved',
          entityType: 'payroll_run',
          entityId: id,
          outcome: 'success',
          ...requestMeta(request),
        });
      });
      return loadRun(getPool(), schoolId, id);
    },
  );

  app.post(
    '/api/schools/:schoolId/payroll/:id/pay',
    { preHandler: requirePermission('hr.payroll.approve') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(payrollPayInput, request.body);
      await withTransaction(async (client) => {
        const existing = await client.query<{ status: string }>(
          'SELECT status FROM payroll_runs WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Payroll run not found');
        if (row.status !== 'approved') {
          throw conflict('Approve the run before marking it paid', 'not_approved');
        }
        await client.query(
          `UPDATE payroll_runs SET status = 'paid', paid_on = $3
           WHERE school_id = $1 AND id = $2`,
          [schoolId, id, input.paidOn],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.payroll_run_paid',
          entityType: 'payroll_run',
          entityId: id,
          outcome: 'success',
          after: { paidOn: input.paidOn },
          ...requestMeta(request),
        });
      });
      return loadRun(getPool(), schoolId, id);
    },
  );

  app.delete(
    '/api/schools/:schoolId/payroll/:id',
    { preHandler: requirePermission('hr.payroll.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      await withTransaction(async (client) => {
        const existing = await client.query<{ status: string }>(
          'SELECT status FROM payroll_runs WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Payroll run not found');
        if (row.status !== 'draft') {
          throw conflict('Approved payroll cannot be deleted', 'not_draft');
        }
        await client.query('DELETE FROM payroll_runs WHERE school_id = $1 AND id = $2', [
          schoolId,
          id,
        ]);
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.payroll_run_deleted',
          entityType: 'payroll_run',
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

async function loadRun(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  id: string,
): Promise<PayrollRunSummary> {
  const { rows } = await client.query<PayrollRow>(
    `${payrollSelect}
     WHERE r.school_id = $1 AND r.id = $2
     GROUP BY r.id, cu.display_name, au.display_name`,
    [schoolId, id],
  );
  if (!rows[0]) throw notFound('Payroll run not found');
  return mapPayroll(rows[0]);
}

interface PayrollRow {
  id: string;
  period_start: string;
  period_end: string;
  status: PayrollRunSummary['status'];
  notes: string | null;
  created_by_name: string | null;
  approved_by_name: string | null;
  approved_at: Date | null;
  paid_on: string | null;
  payslip_count: string;
  gross_total: string;
  deduction_total: string;
  net_total: string;
  created_at: Date;
}

const payrollSelect = `
  SELECT r.id, r.period_start, r.period_end, r.status, r.notes,
         cu.display_name AS created_by_name, au.display_name AS approved_by_name,
         r.approved_at, r.paid_on,
         count(p.id)::text AS payslip_count,
         COALESCE(sum(p.gross_amount), 0)::text AS gross_total,
         COALESCE(sum(p.deductions), 0)::text AS deduction_total,
         COALESCE(sum(p.net_amount), 0)::text AS net_total,
         r.created_at
  FROM payroll_runs r
  LEFT JOIN payslips p ON p.school_id = r.school_id AND p.run_id = r.id
  LEFT JOIN users cu ON cu.id = r.created_by
  LEFT JOIN users au ON au.id = r.approved_by`;

function mapPayroll(row: PayrollRow): PayrollRunSummary {
  return {
    id: row.id,
    periodStart: toIsoDate(row.period_start),
    periodEnd: toIsoDate(row.period_end),
    status: row.status,
    notes: row.notes,
    createdByName: row.created_by_name,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at ? toIsoDateTime(row.approved_at) : null,
    paidOn: row.paid_on ? toIsoDate(row.paid_on) : null,
    payslipCount: Number(row.payslip_count),
    grossTotal: toNumber(row.gross_total),
    deductionTotal: toNumber(row.deduction_total),
    netTotal: toNumber(row.net_total),
    createdAt: toIsoDateTime(row.created_at),
  };
}

interface PayslipRow {
  id: string;
  staff_id: string;
  first_name: string;
  last_name: string | null;
  employee_number: string;
  gross_amount: string;
  deductions: string;
  net_amount: string;
  notes: string | null;
}

function mapPayslip(row: PayslipRow): PayslipRecord {
  return {
    id: row.id,
    staffId: row.staff_id,
    staffName: fullName(row.first_name, null, row.last_name),
    employeeNumber: row.employee_number,
    grossAmount: toNumber(row.gross_amount),
    deductions: toNumber(row.deductions),
    netAmount: toNumber(row.net_amount),
    notes: row.notes,
  };
}
