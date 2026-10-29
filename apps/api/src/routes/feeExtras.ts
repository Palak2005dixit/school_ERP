import {
  installmentPlanInput,
  lateFeeRuleInput,
  lateFeeRunInput,
  uuid,
  type ChargeInstallments,
  type InstallmentRecord,
  type LateFeeAssessmentRecord,
  type LateFeeRuleRecord,
  type LateFeeRunResult,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { fullName } from '@erp/core';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import type { ActorContext } from '../auth/session';
import { getPool, withTransaction } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, notFound, parseInput } from '../lib/errors';
import { assertGuardianLinked } from '../lib/portal';
import { toIsoDate, toNumber } from '../lib/format';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const structureParams = z.object({ schoolId: uuid, structureId: uuid });
const studentParams = z.object({ schoolId: uuid, studentId: uuid });
const paymentParams = z.object({ schoolId: uuid, paymentId: uuid });
const yearQuery = z.object({ academicYearId: uuid.optional() });

const LATE_FEE_HEAD = { code: 'LATE-FEE', name: 'Late fee' };

/**
 * Fee extensions: late-fee rules and assessment, instalment schedules, and
 * printable invoices/receipts. Late fees post to a dedicated head so the
 * original charge is never rewritten. Instalment status is derived from the
 * charge-level allocation, not from a second ledger.
 */
export async function registerFeeExtrasRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------- late fee rules --------------------------- */

  app.get(
    '/api/schools/:schoolId/fee-late-rules',
    { preHandler: requirePermission('fees.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<LateRuleRow>(
        `SELECT id, name, grace_days, percent_per_month, max_amount, active
         FROM fee_late_fee_rules WHERE school_id = $1 ORDER BY name`,
        [schoolId],
      );
      return { items: rows.map(mapRule) };
    },
  );

  app.post(
    '/api/schools/:schoolId/fee-late-rules',
    { preHandler: requirePermission('fees.charge.create') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(lateFeeRuleInput, request.body);
      const created = await withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO fee_late_fee_rules
             (school_id, name, grace_days, percent_per_month, max_amount, active)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [schoolId, input.name, input.graceDays, input.percentPerMonth, input.maxAmount, input.active],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.late_rule_created',
          entityType: 'fee_late_fee_rule',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: input,
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });
      const { rows } = await getPool().query<LateRuleRow>(
        `SELECT id, name, grace_days, percent_per_month, max_amount, active
         FROM fee_late_fee_rules WHERE school_id = $1 AND id = $2`,
        [schoolId, created],
      );
      return reply.status(201).send(mapRule(rows[0]!));
    },
  );

  app.patch(
    '/api/schools/:schoolId/fee-late-rules/:id',
    { preHandler: requirePermission('fees.charge.create') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(lateFeeRuleInput.partial(), request.body);
      await withTransaction(async (client) => {
        const existing = await client.query<LateRuleRow>(
          `SELECT id, name, grace_days, percent_per_month, max_amount, active
           FROM fee_late_fee_rules WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Late fee rule not found');
        await client.query(
          `UPDATE fee_late_fee_rules
           SET name = $3, grace_days = $4, percent_per_month = $5, max_amount = $6, active = $7
           WHERE school_id = $1 AND id = $2`,
          [
            schoolId,
            id,
            input.name ?? row.name,
            input.graceDays ?? row.grace_days,
            input.percentPerMonth ?? row.percent_per_month,
            input.maxAmount ?? row.max_amount,
            input.active ?? row.active,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.late_rule_updated',
          entityType: 'fee_late_fee_rule',
          entityId: id,
          outcome: 'success',
          before: mapRule(row),
          after: input,
          ...requestMeta(request),
        });
      });
      const { rows } = await getPool().query<LateRuleRow>(
        `SELECT id, name, grace_days, percent_per_month, max_amount, active
         FROM fee_late_fee_rules WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      );
      return mapRule(rows[0]!);
    },
  );

  /* ----------------------------- late fee assessment ------------------------ */

  app.post(
    '/api/schools/:schoolId/fees/late-fees/run',
    { preHandler: requirePermission('fees.charge.create') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(lateFeeRunInput, request.body);
      const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);

      const result = await withTransaction(async (client) => {
        const rule = await client.query<LateRuleRow>(
          `SELECT id, name, grace_days, percent_per_month, max_amount, active
           FROM fee_late_fee_rules WHERE school_id = $1 AND id = $2`,
          [schoolId, input.ruleId],
        );
        const ruleRow = rule.rows[0];
        if (!ruleRow) throw notFound('Late fee rule not found');
        if (!ruleRow.active) throw badRequest('That late fee rule is inactive');

        const params: unknown[] = [schoolId, asOf, ruleRow.grace_days];
        let yearFilter = '';
        if (input.academicYearId) {
          params.push(input.academicYearId);
          yearFilter = `AND ch.academic_year_id = $${params.length}`;
        }

        const charges = await client.query<{
          id: string;
          student_id: string;
          academic_year_id: string;
          outstanding: string;
        }>(
          `SELECT ch.id, ch.student_id, ch.academic_year_id,
                  (ch.amount - ch.concession_amount - ch.write_off_amount - COALESCE((
                    SELECT sum(pa.amount) FROM payment_allocations pa
                    JOIN payments p ON p.id = pa.payment_id AND p.status = 'recorded'
                    WHERE pa.charge_id = ch.id
                  ), 0))::text AS outstanding
           FROM student_charges ch
           WHERE ch.school_id = $1
             AND ch.due_on < ($2::date - ($3::int || ' days')::interval)
             ${yearFilter}
           ORDER BY ch.due_on`,
          params,
        );

        let headId: string | null = null;
        let assessed = 0;
        let skipped = 0;
        let totalFee = 0;
        const items: LateFeeAssessmentRecord[] = [];

        for (const charge of charges.rows) {
          const outstanding = Math.max(0, toNumber(charge.outstanding));
          if (outstanding <= 0) {
            skipped += 1;
            continue;
          }
          const months = Math.max(
            1,
            Math.ceil(
              (Date.parse(`${asOf}T00:00:00Z`) -
                Date.parse(
                  `${new Date(
                    Date.parse(`${asOf}T00:00:00Z`) -
                      (ruleRow.grace_days + 1) * 86_400_000,
                  )
                    .toISOString()
                    .slice(0, 10)}T00:00:00Z`,
                )) /
                86_400_000 /
                30,
            ),
          );
          let fee = round((outstanding * toNumber(ruleRow.percent_per_month) * months) / 100);
          const max = toNumber(ruleRow.max_amount);
          if (max > 0) fee = Math.min(fee, max);
          if (fee <= 0) {
            skipped += 1;
            continue;
          }

          const assessment = await client.query<{ id: string }>(
            `INSERT INTO late_fee_assessments
               (school_id, charge_id, rule_id, assessed_on, base_amount, fee_amount, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (school_id, charge_id, assessed_on) DO NOTHING
             RETURNING id`,
            [schoolId, charge.id, ruleRow.id, asOf, outstanding, fee, actor.userId],
          );
          if (!assessment.rows[0]) {
            skipped += 1;
            continue;
          }

          if (!headId) {
            const head = await client.query<{ id: string }>(
              `INSERT INTO fee_heads (school_id, code, name, description, status)
               VALUES ($1, $2, $3, 'Automatically assessed late fees', 'active')
               ON CONFLICT (school_id, code) DO UPDATE SET name = EXCLUDED.name
               RETURNING id`,
              [schoolId, LATE_FEE_HEAD.code, LATE_FEE_HEAD.name],
            );
            headId = head.rows[0]!.id;
          }

          const chargeRow = await client.query<{ id: string }>(
            `INSERT INTO student_charges
               (school_id, student_id, academic_year_id, fee_head_id, description,
                amount, due_on, created_by)
             VALUES ($1, $2, $3, $4, 'Late fee', $5, $6, $7)
             ON CONFLICT (student_id, academic_year_id, fee_head_id)
             DO UPDATE SET amount = student_charges.amount + EXCLUDED.amount,
                           updated_at = now()
             RETURNING id`,
            [schoolId, charge.student_id, charge.academic_year_id, headId, fee, asOf, actor.userId],
          );

          const student = await client.query<{ first_name: string; last_name: string | null }>(
            'SELECT first_name, last_name FROM students WHERE school_id = $1 AND id = $2',
            [schoolId, charge.student_id],
          );

          assessed += 1;
          totalFee = round(totalFee + fee);
          items.push({
            id: assessment.rows[0]!.id,
            chargeId: chargeRow.rows[0]!.id,
            studentName: fullName(student.rows[0]?.first_name, null, student.rows[0]?.last_name),
            assessedOn: asOf,
            baseAmount: outstanding,
            feeAmount: fee,
            createdByName: actor.displayName,
          });
        }

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.late_fees_assessed',
          entityType: 'fee_late_fee_rule',
          entityId: ruleRow.id,
          outcome: 'success',
          after: { asOf, assessed, skipped, totalFee },
          ...requestMeta(request),
        });

        const response: LateFeeRunResult = { assessed, skipped, totalFee, items };
        return response;
      });

      return result;
    },
  );

  /* ------------------------------- instalments ------------------------------ */

  app.get(
    '/api/schools/:schoolId/fee-structures/:structureId/installments',
    { preHandler: requirePermission('fees.view') },
    async (request) => {
      const { schoolId, structureId } = parseInput(structureParams, request.params);
      const { rows } = await getPool().query<{
        sequence: number;
        label: string;
        percent: string;
        due_on: string;
      }>(
        `SELECT sequence, label, percent, due_on FROM fee_installment_plans
         WHERE school_id = $1 AND structure_id = $2 ORDER BY sequence`,
        [schoolId, structureId],
      );
      return {
        items: rows.map((row) => ({
          sequence: row.sequence,
          label: row.label,
          percent: toNumber(row.percent),
          dueOn: toIsoDate(row.due_on),
        })),
      };
    },
  );

  app.put(
    '/api/schools/:schoolId/fee-structures/:structureId/installments',
    { preHandler: requirePermission('fees.charge.create') },
    async (request) => {
      const { schoolId, structureId } = parseInput(structureParams, request.params);
      const actor = getActor(request);
      const input = parseInput(installmentPlanInput, request.body);
      const sum = round(input.items.reduce((total, item) => total + item.percent, 0));
      if (Math.abs(sum - 100) > 0.01) {
        throw badRequest('Instalment percentages must add up to 100', {
          items: [`They currently add up to ${sum}`],
        });
      }
      const sequences = new Set(input.items.map((item) => item.sequence));
      if (sequences.size !== input.items.length) {
        throw badRequest('Each instalment needs a unique sequence number');
      }

      await withTransaction(async (client) => {
        const structure = await client.query(
          'SELECT 1 FROM fee_structures WHERE school_id = $1 AND id = $2',
          [schoolId, structureId],
        );
        if (structure.rowCount === 0) throw notFound('Fee structure not found');
        await client.query(
          'DELETE FROM fee_installment_plans WHERE school_id = $1 AND structure_id = $2',
          [schoolId, structureId],
        );
        for (const item of input.items) {
          await client.query(
            `INSERT INTO fee_installment_plans
               (school_id, structure_id, sequence, label, percent, due_on)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [schoolId, structureId, item.sequence, item.label, item.percent, item.dueOn],
          );
        }
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.installment_plan_updated',
          entityType: 'fee_structure',
          entityId: structureId,
          outcome: 'success',
          after: { items: input.items.length },
          ...requestMeta(request),
        });
      });
      return { items: input.items };
    },
  );

  app.get(
    '/api/schools/:schoolId/fees/students/:studentId/installments',
    { preHandler: requirePermission('fees.view') },
    async (request) => {
      const { schoolId, studentId } = parseInput(studentParams, request.params);
      const actor = getActor(request);
      await assertCanViewStudentFees(actor, schoolId, studentId);
      const query = parseInput(yearQuery, request.query);
      return { items: await loadInstallments(getPool(), schoolId, studentId, query.academicYearId) };
    },
  );

  /* ---------------------------- printable documents ------------------------- */

  app.get(
    '/api/schools/:schoolId/fees/students/:studentId/invoice',
    { preHandler: requirePermission('fees.view') },
    async (request, reply) => {
      const { schoolId, studentId } = parseInput(studentParams, request.params);
      const actor = getActor(request);
      await assertCanViewStudentFees(actor, schoolId, studentId);
      const query = parseInput(yearQuery, request.query);
      const html = await renderInvoice(schoolId, studentId, query.academicYearId);
      return reply.header('content-type', 'text/html; charset=utf-8').send(html);
    },
  );

  app.get(
    '/api/schools/:schoolId/fees/payments/:paymentId/receipt',
    { preHandler: requirePermission('fees.view') },
    async (request, reply) => {
      const { schoolId, paymentId } = parseInput(paymentParams, request.params);
      const actor = getActor(request);
      const payment = await getPool().query<{ student_id: string }>(
        'SELECT student_id FROM payments WHERE school_id = $1 AND id = $2',
        [schoolId, paymentId],
      );
      if (!payment.rows[0]) throw notFound('Payment not found');
      await assertCanViewStudentFees(actor, schoolId, payment.rows[0].student_id);
      const html = await renderReceipt(schoolId, paymentId);
      return reply.header('content-type', 'text/html; charset=utf-8').send(html);
    },
  );

  app.get(
    '/api/schools/:schoolId/portal/children/:studentId/invoice',
    { preHandler: requirePermission('guardian.student.view') },
    async (request, reply) => {
      const { schoolId, studentId } = parseInput(studentParams, request.params);
      const actor = getActor(request);
      await assertGuardianLinked(getPool(), schoolId, actor.userId, studentId);
      const query = parseInput(yearQuery, request.query);
      const html = await renderInvoice(schoolId, studentId, query.academicYearId);
      return reply.header('content-type', 'text/html; charset=utf-8').send(html);
    },
  );

  app.get(
    '/api/schools/:schoolId/portal/children/:studentId/receipts/:paymentId',
    { preHandler: requirePermission('guardian.student.view') },
    async (request, reply) => {
      const { schoolId, studentId, paymentId } = parseInput(
        z.object({ schoolId: uuid, studentId: uuid, paymentId: uuid }),
        request.params,
      );
      const actor = getActor(request);
      await assertGuardianLinked(getPool(), schoolId, actor.userId, studentId);
      const payment = await getPool().query(
        'SELECT 1 FROM payments WHERE school_id = $1 AND id = $2 AND student_id = $3',
        [schoolId, paymentId, studentId],
      );
      if (!payment.rows[0]) throw notFound('Payment not found');
      const html = await renderReceipt(schoolId, paymentId);
      return reply.header('content-type', 'text/html; charset=utf-8').send(html);
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

async function assertCanViewStudentFees(
  actor: ActorContext,
  schoolId: string,
  studentId: string,
): Promise<void> {
  // Staff with profile visibility can review any student in their school.
  if (actor.permissions.has('students.profile.view')) return;
  await assertGuardianLinked(getPool(), schoolId, actor.userId, studentId);
}

interface LateRuleRow {
  id: string;
  name: string;
  grace_days: number;
  percent_per_month: string;
  max_amount: string;
  active: boolean;
}

function mapRule(row: LateRuleRow): LateFeeRuleRecord {
  return {
    id: row.id,
    name: row.name,
    graceDays: Number(row.grace_days),
    percentPerMonth: toNumber(row.percent_per_month),
    maxAmount: toNumber(row.max_amount),
    active: row.active,
  };
}

async function loadInstallments(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  studentId: string,
  academicYearId: string | undefined,
): Promise<ChargeInstallments[]> {
  const params: unknown[] = [schoolId, studentId];
  let yearFilter = '';
  if (academicYearId) {
    params.push(academicYearId);
    yearFilter = `AND ch.academic_year_id = $${params.length}`;
  }

  const { rows } = await client.query<{
    charge_id: string;
    description: string;
    net: string;
    paid: string;
    structure_id: string | null;
  }>(
    `SELECT ch.id AS charge_id, ch.description,
            (ch.amount - ch.concession_amount - ch.write_off_amount)::text AS net,
            COALESCE((
              SELECT sum(pa.amount) FROM payment_allocations pa
              JOIN payments p ON p.id = pa.payment_id AND p.status = 'recorded'
              WHERE pa.charge_id = ch.id
            ), 0)::text AS paid,
            fs.id AS structure_id
     FROM student_charges ch
     LEFT JOIN LATERAL (
       SELECT e.section_id FROM enrollments e
       WHERE e.student_id = ch.student_id AND e.enrollment_status = 'active'
       ORDER BY e.starts_on DESC LIMIT 1
     ) e ON true
     LEFT JOIN sections sec ON sec.id = e.section_id
     LEFT JOIN fee_structures fs
       ON fs.school_id = ch.school_id AND fs.academic_year_id = ch.academic_year_id
      AND fs.class_id = sec.class_id AND fs.fee_head_id = ch.fee_head_id
     WHERE ch.school_id = $1 AND ch.student_id = $2 ${yearFilter}
     ORDER BY ch.due_on, ch.description`,
    params,
  );

  const result: ChargeInstallments[] = [];
  for (const row of rows) {
    const amount = toNumber(row.net);
    const paid = Math.min(amount, toNumber(row.paid));
    let plans: Array<{ sequence: number; label: string; percent: string; due_on: string }> = [];
    if (row.structure_id) {
      const plan = await client.query<{
        sequence: number;
        label: string;
        percent: string;
        due_on: string;
      }>(
        `SELECT sequence, label, percent, due_on FROM fee_installment_plans
         WHERE school_id = $1 AND structure_id = $2 ORDER BY sequence`,
        [schoolId, row.structure_id],
      );
      plans = plan.rows;
    }

    const today = new Date().toISOString().slice(0, 10);
    let cumulative = 0;
    const installments: InstallmentRecord[] = plans.map((plan) => {
      const installmentAmount = round((amount * toNumber(plan.percent)) / 100);
      const before = cumulative;
      cumulative = round(cumulative + installmentAmount);
      const paidForThis = Math.min(installmentAmount, Math.max(0, paid - before));
      const dueOn = toIsoDate(plan.due_on);
      const status: InstallmentRecord['status'] =
        paidForThis >= installmentAmount
          ? 'paid'
          : paidForThis > 0
            ? 'partial'
            : dueOn < today
              ? 'overdue'
              : 'pending';
      return {
        sequence: plan.sequence,
        label: plan.label,
        percent: toNumber(plan.percent),
        dueOn,
        amount: installmentAmount,
        paidAmount: round(paidForThis),
        status,
      };
    });

    result.push({
      chargeId: row.charge_id,
      description: row.description,
      amount,
      paidAmount: round(paid),
      installments,
    });
  }
  return result;
}

async function renderInvoice(
  schoolId: string,
  studentId: string,
  academicYearId: string | undefined,
): Promise<string> {
  const school = await getPool().query<{ name: string; code: string; address: string | null }>(
    `SELECT name, code, NULL::text AS address FROM schools WHERE id = $1`,
    [schoolId],
  );
  if (!school.rows[0]) throw notFound('School not found');
  const student = await getPool().query<{
    first_name: string;
    middle_name: string | null;
    last_name: string | null;
    admission_number: string;
    class_name: string | null;
    section_name: string | null;
  }>(
    `SELECT st.first_name, st.middle_name, st.last_name, st.admission_number,
            c.name AS class_name, sec.name AS section_name
     FROM students st
     LEFT JOIN LATERAL (
       SELECT e.section_id FROM enrollments e
       WHERE e.student_id = st.id AND e.enrollment_status = 'active'
       ORDER BY e.starts_on DESC LIMIT 1
     ) e ON true
     LEFT JOIN sections sec ON sec.id = e.section_id
     LEFT JOIN classes c ON c.id = sec.class_id
     WHERE st.school_id = $1 AND st.id = $2`,
    [schoolId, studentId],
  );
  const studentRow = student.rows[0];
  if (!studentRow) throw notFound('Student not found');

  const year = await getPool().query<{ id: string; name: string }>(
    academicYearId
      ? 'SELECT id, name FROM academic_years WHERE school_id = $1 AND id = $2'
      : `SELECT id, name FROM academic_years WHERE school_id = $1 AND status = 'active' LIMIT 1`,
    academicYearId ? [schoolId, academicYearId] : [schoolId],
  );
  const yearRow = year.rows[0];
  if (!yearRow) throw badRequest('No academic year is active');

  const charges = await getPool().query<{
    description: string;
    amount: string;
    concession: string;
    write_off: string;
    due_on: string;
    paid: string;
  }>(
    `SELECT ch.description, ch.amount, ch.concession_amount AS concession,
            ch.write_off_amount AS write_off, ch.due_on,
            COALESCE((
              SELECT sum(pa.amount) FROM payment_allocations pa
              JOIN payments p ON p.id = pa.payment_id AND p.status = 'recorded'
              WHERE pa.charge_id = ch.id
            ), 0)::text AS paid
     FROM student_charges ch
     WHERE ch.school_id = $1 AND ch.student_id = $2 AND ch.academic_year_id = $3
     ORDER BY ch.due_on, ch.description`,
    [schoolId, studentId, yearRow.id],
  );

  let total = 0;
  let paidTotal = 0;
  const rows = charges.rows
    .map((charge) => {
      const net = round(
        toNumber(charge.amount) - toNumber(charge.concession) - toNumber(charge.write_off),
      );
      const paid = Math.min(net, toNumber(charge.paid));
      total = round(total + net);
      paidTotal = round(paidTotal + paid);
      return `<tr><td>${escapeHtml(charge.description)}</td><td>${escapeHtml(
        toIsoDate(charge.due_on),
      )}</td><td class="num">${formatMoney(net)}</td><td class="num">${formatMoney(paid)}</td><td class="num">${formatMoney(
        round(net - paid),
      )}</td></tr>`;
    })
    .join('');

  return printableDocument({
    title: `Fee invoice · ${escapeHtml(studentRow.admission_number)}`,
    school: school.rows[0],
    heading: 'Fee invoice',
    meta: [
      ['Student', fullName(studentRow.first_name, studentRow.middle_name, studentRow.last_name)],
      ['Admission no.', studentRow.admission_number],
      ['Class', [studentRow.class_name, studentRow.section_name].filter(Boolean).join(' / ')],
      ['Academic year', yearRow.name],
      ['Invoice', `INV-${yearRow.name.replace(/\s+/g, '-')}-${studentRow.admission_number}`],
    ],
    body: `
      <table>
        <thead><tr><th>Charge</th><th>Due</th><th class="num">Net</th><th class="num">Paid</th><th class="num">Outstanding</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">No charges recorded.</td></tr>'}</tbody>
      </table>
      <p class="total">Total: ${formatMoney(total)} · Paid: ${formatMoney(paidTotal)} · Outstanding: ${formatMoney(
        round(total - paidTotal),
      )}</p>`,
  });
}

async function renderReceipt(schoolId: string, paymentId: string): Promise<string> {
  const school = await getPool().query<{ name: string; code: string; address: string | null }>(
    'SELECT name, code, NULL::text AS address FROM schools WHERE id = $1',
    [schoolId],
  );
  if (!school.rows[0]) throw notFound('School not found');
  const payment = await getPool().query<{
    receipt_number: string;
    amount: string;
    method: string;
    reference: string | null;
    paid_on: string;
    status: string;
    student_first: string;
    student_middle: string | null;
    student_last: string | null;
    admission_number: string;
    recorded_by: string | null;
  }>(
    `SELECT p.receipt_number, p.amount, p.method, p.reference, p.paid_on, p.status,
            st.first_name AS student_first, st.middle_name AS student_middle,
            st.last_name AS student_last, st.admission_number,
            u.display_name AS recorded_by
     FROM payments p
     JOIN students st ON st.id = p.student_id AND st.school_id = p.school_id
     LEFT JOIN users u ON u.id = p.recorded_by
     WHERE p.school_id = $1 AND p.id = $2`,
    [schoolId, paymentId],
  );
  const row = payment.rows[0];
  if (!row) throw notFound('Payment not found');

  const allocations = await getPool().query<{ description: string; amount: string }>(
    `SELECT ch.description, pa.amount
     FROM payment_allocations pa
     JOIN student_charges ch ON ch.id = pa.charge_id AND ch.school_id = pa.school_id
     WHERE pa.school_id = $1 AND pa.payment_id = $2
     ORDER BY ch.description`,
    [schoolId, paymentId],
  );

  return printableDocument({
    title: `Receipt ${row.receipt_number}`,
    school: school.rows[0],
    heading: 'Fee receipt',
    meta: [
      [
        'Student',
        fullName(row.student_first, row.student_middle, row.student_last),
      ],
      ['Admission no.', row.admission_number],
      ['Receipt no.', row.receipt_number],
      ['Paid on', toIsoDate(row.paid_on)],
      ['Method', row.method.replace(/_/g, ' ')],
      ['Status', row.status],
      ['Recorded by', row.recorded_by ?? '—'],
    ],
    body: `
      <p class="amount">${formatMoney(toNumber(row.amount))}</p>
      ${
        row.reference ? `<p>Reference: ${escapeHtml(row.reference)}</p>` : ''
      }
      <table>
        <thead><tr><th>Allocated to</th><th class="num">Amount</th></tr></thead>
        <tbody>${
          allocations.rows
            .map(
              (allocation) =>
                `<tr><td>${escapeHtml(allocation.description)}</td><td class="num">${formatMoney(
                  toNumber(allocation.amount),
                )}</td></tr>`,
            )
            .join('') || '<tr><td colspan="2">Unallocated payment.</td></tr>'
        }</tbody>
      </table>`,
  });
}

function printableDocument(input: {
  title: string;
  school: { name: string; code: string; address: string | null };
  heading: string;
  meta: Array<[string, string]>;
  body: string;
}): string {
  const meta = input.meta
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${input.title}</title>
<style>
  :root { font-family: system-ui, -apple-system, Segoe UI, sans-serif; color: #0f172a; }
  body { max-width: 820px; margin: 32px auto; padding: 0 24px; }
  header { border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; text-transform: uppercase; letter-spacing: .08em; color: #475569; margin: 20px 0 8px; }
  .school { font-size: 13px; color: #475569; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; font-size: 14px; }
  dt { color: #64748b; }
  dd { margin: 0; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px; }
  th, td { border-bottom: 1px solid #e2e8f0; padding: 8px 6px; text-align: left; }
  th { background: #f8fafc; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .total, .amount { margin-top: 18px; font-size: 16px; font-weight: 700; }
  .amount { font-size: 28px; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(input.school.name)}</h1>
  <div class="school">${escapeHtml(input.school.code)}${
    input.school.address ? ` · ${escapeHtml(input.school.address)}` : ''
  }</div>
</header>
<h2>${input.heading}</h2>
<dl>${meta}</dl>
${input.body}
<script>window.addEventListener('load', function () { window.print(); });</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
