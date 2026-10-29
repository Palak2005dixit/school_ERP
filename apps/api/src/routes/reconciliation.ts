import {
  concessionDecisionInput,
  concessionRequestInput,
  reconciliationBatchInput,
  reconciliationLineInput,
  reconciliationMatchInput,
  uuid,
  writeOffInput,
  type FeeConcessionRequest,
  type FeeWriteOff,
  type ReconciliationBatch,
  type ReconciliationLine,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { getActor, requireAnyPermission, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, conflict, notFound, parseInput } from '../lib/errors';
import { toIsoDate, toIsoDateTime, toNumber } from '../lib/format';
import { idempotentRoute } from '../lib/idempotency';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const lineParams = z.object({ schoolId: uuid, id: uuid, lineId: uuid });
const decisionQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
});
const batchQuery = z.object({
  status: z.enum(['draft', 'balanced', 'closed']).optional(),
});
const paymentQuery = z.object({
  search: z.string().trim().max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

/**
 * Fee concessions, write-offs and offline statement reconciliation.
 *
 * Every balance-changing path locks the charge row, checks the remaining
 * collectable amount (amount - concession - write-off - paid) and records its
 * evidence row and audit event in the same transaction. Reconciliation never
 * creates a payment from a statement line; a finance user explicitly matches a
 * line to an existing recorded payment or marks it as an exception.
 */
export async function registerReconciliationRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------- concessions ----------------------------- */

  app.get(
    '/api/schools/:schoolId/fees/concessions',
    { preHandler: requireAnyPermission('fees.view', 'fees.concession.approve') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(decisionQuery, request.query);
      const params: unknown[] = [schoolId];
      let filter = '';
      if (query.status) {
        params.push(query.status);
        filter = `AND r.status = $${params.length}`;
      }
      const { rows } = await getPool().query<{
        id: string;
        student_id: string;
        student_name: string;
        academic_year_id: string;
        charge_id: string;
        charge_description: string;
        amount: string;
        reason: string;
        status: FeeConcessionRequest['status'];
        requester_name: string | null;
        requested_at: Date;
        reviewer_name: string | null;
        reviewed_at: Date | null;
        review_note: string | null;
      }>(
        `SELECT r.id, r.student_id,
                concat_ws(' ', s.first_name, s.middle_name, s.last_name) AS student_name,
                r.academic_year_id, r.charge_id, ch.description AS charge_description,
                r.amount, r.reason, r.status, ru.display_name AS requester_name,
                r.requested_at, vu.display_name AS reviewer_name, r.reviewed_at, r.review_note
         FROM fee_concession_requests r
         JOIN students s ON s.id = r.student_id AND s.school_id = r.school_id
         JOIN student_charges ch ON ch.id = r.charge_id AND ch.school_id = r.school_id
         LEFT JOIN users ru ON ru.id = r.requested_by
         LEFT JOIN users vu ON vu.id = r.reviewed_by
         WHERE r.school_id = $1 ${filter}
         ORDER BY r.requested_at DESC`,
        params,
      );
      const items: FeeConcessionRequest[] = rows.map((row) => ({
        id: row.id,
        studentId: row.student_id,
        studentName: row.student_name,
        academicYearId: row.academic_year_id,
        chargeId: row.charge_id,
        chargeDescription: row.charge_description,
        amount: toNumber(row.amount),
        reason: row.reason,
        status: row.status,
        requestedByName: row.requester_name,
        requestedAt: toIsoDateTime(row.requested_at),
        reviewedByName: row.reviewer_name,
        reviewedAt: row.reviewed_at ? toIsoDateTime(row.reviewed_at) : null,
        reviewNote: row.review_note,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/fees/concessions',
    { preHandler: requireAnyPermission('fees.view', 'fees.concession.approve') },
    idempotentRoute('POST /fees/concessions', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(concessionRequestInput, request.body);
      const actor = getActor(request);
      const created = await withTransaction(async (client) => {
        const charge = await client.query<{
          student_id: string;
          academic_year_id: string;
          amount: string;
          concession_amount: string;
          write_off_amount: string;
        }>(
          `SELECT student_id, academic_year_id, amount, concession_amount, write_off_amount
           FROM student_charges WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, input.chargeId],
        );
        const row = charge.rows[0];
        if (!row) throw notFound('Charge not found');
        if (row.student_id !== input.studentId || row.academic_year_id !== input.academicYearId) {
          throw badRequest('The charge does not belong to that student and academic year');
        }
        const available = round(
          toNumber(row.amount) - toNumber(row.concession_amount) - toNumber(row.write_off_amount),
        );
        if (input.amount > available) {
          throw badRequest('The request exceeds the remaining charge amount', {
            amount: [`Enter up to ${available.toFixed(2)}`],
          });
        }
        const pending = await client.query(
          `SELECT 1 FROM fee_concession_requests
           WHERE school_id = $1 AND charge_id = $2 AND status = 'pending'`,
          [schoolId, input.chargeId],
        );
        if (pending.rowCount) {
          throw conflict(
            'This charge already has a pending concession request',
            'concession_pending',
          );
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO fee_concession_requests
             (school_id, student_id, academic_year_id, charge_id, amount, reason, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            schoolId,
            input.studentId,
            input.academicYearId,
            input.chargeId,
            input.amount,
            input.reason,
            actor.userId,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.concession_requested',
          entityType: 'fee_concession_request',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: { chargeId: input.chargeId, amount: input.amount },
          ...requestMeta(request),
        });
        return { id: rows[0]!.id, status: 'pending' };
      });
      return reply.status(201).send(created);
    }),
  );

  app.post(
    '/api/schools/:schoolId/fees/concessions/:id/decision',
    { preHandler: requirePermission('fees.concession.approve') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(concessionDecisionInput, request.body);
      const actor = getActor(request);
      const result = await withTransaction(async (client) => {
        const found = await client.query<{
          charge_id: string;
          amount: string;
          reason: string;
          status: FeeConcessionRequest['status'];
          requested_by: string;
          student_id: string;
          academic_year_id: string;
        }>(
          `SELECT charge_id, amount, reason, status, requested_by, student_id, academic_year_id
           FROM fee_concession_requests
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = found.rows[0];
        if (!row) throw notFound('Concession request not found');
        if (row.status !== 'pending') throw conflict('This request has already been reviewed');
        if (row.requested_by === actor.userId) {
          throw conflict('You cannot review a concession you requested', 'segregation_of_duties');
        }

        if (input.decision === 'approve') {
          const charge = await client.query<{
            amount: string;
            concession_amount: string;
            write_off_amount: string;
            concession_reason: string | null;
            student_id: string;
            academic_year_id: string;
          }>(
            `SELECT amount, concession_amount, write_off_amount, concession_reason,
                    student_id, academic_year_id
             FROM student_charges WHERE school_id = $1 AND id = $2 FOR UPDATE`,
            [schoolId, row.charge_id],
          );
          const current = charge.rows[0];
          if (!current) throw notFound('Charge not found');
          if (
            current.student_id !== row.student_id ||
            current.academic_year_id !== row.academic_year_id
          ) {
            throw conflict('The charge no longer matches this concession request');
          }
          const nextConcession = round(toNumber(current.concession_amount) + toNumber(row.amount));
          if (
            nextConcession + toNumber(current.write_off_amount) >
            toNumber(current.amount)
          ) {
            throw conflict('Approving this concession would exceed the charge amount');
          }
          await client.query(
            `UPDATE student_charges SET concession_amount = $3, concession_reason = $4
             WHERE school_id = $1 AND id = $2`,
            [
              schoolId,
              row.charge_id,
              nextConcession,
              current.concession_reason
                ? `${current.concession_reason}; ${row.reason}`
                : row.reason,
            ],
          );
        }

        await client.query(
          `UPDATE fee_concession_requests SET
             status = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5
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
          action: 'fees.concession_reviewed',
          entityType: 'fee_concession_request',
          entityId: id,
          outcome: 'success',
          before: { status: row.status },
          after: { decision: input.decision, amount: toNumber(row.amount) },
          ...requestMeta(request),
        });
        return { id, status: input.decision === 'approve' ? 'approved' : 'rejected' };
      });
      return result;
    },
  );

  /* -------------------------------- write-offs ----------------------------- */

  app.get(
    '/api/schools/:schoolId/fees/write-offs',
    { preHandler: requireAnyPermission('fees.view', 'fees.writeoff.approve') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        charge_id: string;
        student_name: string;
        charge_description: string;
        amount: string;
        reason: string;
        approved_by_name: string | null;
        approved_at: Date;
      }>(
        `SELECT w.id, w.charge_id,
                concat_ws(' ', s.first_name, s.middle_name, s.last_name) AS student_name,
                ch.description AS charge_description, w.amount, w.reason,
                u.display_name AS approved_by_name, w.approved_at
         FROM fee_write_offs w
         JOIN student_charges ch ON ch.id = w.charge_id AND ch.school_id = w.school_id
         JOIN students s ON s.id = ch.student_id AND s.school_id = ch.school_id
         LEFT JOIN users u ON u.id = w.approved_by
         WHERE w.school_id = $1 ORDER BY w.approved_at DESC`,
        [schoolId],
      );
      const items: FeeWriteOff[] = rows.map((row) => ({
        id: row.id,
        chargeId: row.charge_id,
        studentName: row.student_name,
        chargeDescription: row.charge_description,
        amount: toNumber(row.amount),
        reason: row.reason,
        approvedByName: row.approved_by_name,
        approvedAt: toIsoDateTime(row.approved_at),
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/fees/write-offs',
    { preHandler: requirePermission('fees.writeoff.approve') },
    idempotentRoute('POST /fees/write-offs', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(writeOffInput, request.body);
      const actor = getActor(request);
      const created = await withTransaction(async (client) => {
        const charge = await client.query<{
          amount: string;
          concession_amount: string;
          write_off_amount: string;
          paid: string;
        }>(
          `SELECT ch.amount, ch.concession_amount, ch.write_off_amount,
                  COALESCE((
                    SELECT sum(pa.amount) FROM payment_allocations pa
                    JOIN payments p ON p.id = pa.payment_id AND p.school_id = pa.school_id
                    WHERE pa.school_id = ch.school_id AND pa.charge_id = ch.id
                      AND p.status = 'recorded'
                  ), 0)::text AS paid
           FROM student_charges ch
           WHERE ch.school_id = $1 AND ch.id = $2 FOR UPDATE`,
          [schoolId, input.chargeId],
        );
        const row = charge.rows[0];
        if (!row) throw notFound('Charge not found');
        const outstanding = round(
          toNumber(row.amount) -
            toNumber(row.concession_amount) -
            toNumber(row.write_off_amount) -
            toNumber(row.paid),
        );
        if (input.amount > outstanding) {
          throw badRequest('A write-off cannot exceed the unpaid balance', {
            amount: [`Enter up to ${outstanding.toFixed(2)}`],
          });
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO fee_write_offs
             (school_id, charge_id, amount, reason, approved_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [schoolId, input.chargeId, input.amount, input.reason, actor.userId],
        );
        await client.query(
          `UPDATE student_charges SET write_off_amount = write_off_amount + $3
           WHERE school_id = $1 AND id = $2`,
          [schoolId, input.chargeId, input.amount],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.written_off',
          entityType: 'fee_write_off',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: { chargeId: input.chargeId, amount: input.amount, outstandingBefore: outstanding },
          ...requestMeta(request),
        });
        return { id: rows[0]!.id, amount: input.amount };
      });
      return reply.status(201).send(created);
    }),
  );

  /* ------------------------------- reconciliation -------------------------- */

  app.get(
    '/api/schools/:schoolId/fees/reconciliation/batches',
    { preHandler: requireAnyPermission('fees.view', 'fees.reconciliation.manage') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(batchQuery, request.query);
      const params: unknown[] = [schoolId];
      let filter = '';
      if (query.status) {
        params.push(query.status);
        filter = `AND b.status = $${params.length}`;
      }
      const { rows } = await getPool().query<BatchRow & { line_count: string }>(
        `SELECT ${batchColumns},
                (SELECT count(*) FROM fee_reconciliation_lines l
                 WHERE l.school_id = b.school_id AND l.batch_id = b.id)::text AS line_count
         FROM fee_reconciliation_batches b
         WHERE b.school_id = $1 ${filter}
         ORDER BY b.created_at DESC`,
        params,
      );
      const items: ReconciliationBatch[] = rows.map(toBatch);
      return { items };
    },
  );

  app.get(
    '/api/schools/:schoolId/fees/reconciliation/batches/:id',
    { preHandler: requireAnyPermission('fees.view', 'fees.reconciliation.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const { rows } = await getPool().query<BatchRow & { line_count: string }>(
        `SELECT ${batchColumns},
                (SELECT count(*) FROM fee_reconciliation_lines l
                 WHERE l.school_id = b.school_id AND l.batch_id = b.id)::text AS line_count
         FROM fee_reconciliation_batches b
         WHERE b.school_id = $1 AND b.id = $2`,
        [schoolId, id],
      );
      if (!rows[0]) throw notFound('Reconciliation batch not found');
      const lines = await getPool().query<LineRow>(
        `${lineSelect}
         WHERE l.school_id = $1 AND l.batch_id = $2
         ORDER BY l.line_no`,
        [schoolId, id],
      );
      return { ...toBatch(rows[0]), lines: lines.rows.map(toLine) };
    },
  );

  app.post(
    '/api/schools/:schoolId/fees/reconciliation/batches',
    { preHandler: requirePermission('fees.reconciliation.manage') },
    idempotentRoute('POST /fees/reconciliation/batches', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(reconciliationBatchInput, request.body);
      const actor = getActor(request);
      if (input.statementFrom && input.statementTo && input.statementTo < input.statementFrom) {
        throw badRequest('The statement end date must be on or after the start date', {
          statementTo: ['Choose a date on or after the start date'],
        });
      }
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO fee_reconciliation_batches
           (school_id, reference, source, statement_from, statement_to, opening_balance,
            closing_balance, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          schoolId,
          input.reference,
          input.source ?? 'bank_statement',
          input.statementFrom ?? null,
          input.statementTo ?? null,
          input.openingBalance ?? null,
          input.closingBalance ?? null,
          input.notes ?? null,
          actor.userId,
        ],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'fees.reconciliation_batch_created',
        entityType: 'fee_reconciliation_batch',
        entityId: rows[0]!.id,
        outcome: 'success',
        after: { reference: input.reference, source: input.source ?? 'bank_statement' },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id });
    }),
  );

  app.post(
    '/api/schools/:schoolId/fees/reconciliation/batches/:id/lines',
    { preHandler: requirePermission('fees.reconciliation.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(reconciliationLineInput, request.body);
      const actor = getActor(request);
      const created = await withTransaction(async (client) => {
        const batch = await client.query<{ status: ReconciliationBatch['status'] }>(
          `SELECT status FROM fee_reconciliation_batches
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = batch.rows[0];
        if (!row) throw notFound('Reconciliation batch not found');
        if (row.status === 'closed') throw conflict('A closed batch cannot be edited');
        const next = await client.query<{ line_no: string }>(
          `SELECT (COALESCE(max(line_no), 0) + 1)::text AS line_no
           FROM fee_reconciliation_lines WHERE school_id = $1 AND batch_id = $2`,
          [schoolId, id],
        );
        const { rows } = await client.query<{ id: string; line_no: number }>(
          `INSERT INTO fee_reconciliation_lines
             (school_id, batch_id, line_no, paid_on, amount, reference, method)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, line_no`,
          [
            schoolId,
            id,
            Number(next.rows[0]?.line_no ?? 1),
            input.paidOn,
            input.amount,
            input.reference ?? null,
            input.method,
          ],
        );
        await refreshBatchStatus(client, schoolId, id);
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.reconciliation_line_added',
          entityType: 'fee_reconciliation_line',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: { batchId: id, amount: input.amount, method: input.method },
          ...requestMeta(request),
        });
        return { id: rows[0]!.id, lineNo: rows[0]!.line_no };
      });
      return reply.status(201).send(created);
    },
  );

  app.patch(
    '/api/schools/:schoolId/fees/reconciliation/batches/:id/lines/:lineId',
    { preHandler: requirePermission('fees.reconciliation.manage') },
    async (request) => {
      const { schoolId, id, lineId } = parseInput(lineParams, request.params);
      const input = parseInput(reconciliationMatchInput, request.body);
      const actor = getActor(request);
      const result = await withTransaction(async (client) => {
        const batch = await client.query<{ status: ReconciliationBatch['status'] }>(
          `SELECT status FROM fee_reconciliation_batches
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        if (!batch.rows[0]) throw notFound('Reconciliation batch not found');
        if (batch.rows[0].status === 'closed') throw conflict('A closed batch cannot be edited');
        const found = await client.query<{ amount: string; status: ReconciliationLine['status'] }>(
          `SELECT amount, status FROM fee_reconciliation_lines
           WHERE school_id = $1 AND batch_id = $2 AND id = $3 FOR UPDATE`,
          [schoolId, id, lineId],
        );
        const line = found.rows[0];
        if (!line) throw notFound('Statement line not found');

        let status: ReconciliationLine['status'] = 'unmatched';
        let matchedPaymentId: string | null = null;
        let exceptionReason: string | null = null;
        if (input.paymentId) {
          const payment = await client.query<{
            amount: string;
            status: string;
            receipt_number: string;
          }>(
            `SELECT amount, status, receipt_number FROM payments
             WHERE school_id = $1 AND id = $2`,
            [schoolId, input.paymentId],
          );
          const paymentRow = payment.rows[0];
          if (!paymentRow) throw notFound('Payment not found');
          if (paymentRow.status !== 'recorded') {
            throw badRequest('A reversed payment cannot be matched');
          }
          const taken = await client.query(
            `SELECT 1 FROM fee_reconciliation_lines
             WHERE school_id = $1 AND matched_payment_id = $2 AND id <> $3`,
            [schoolId, input.paymentId, lineId],
          );
          if (taken.rowCount) {
            throw conflict('That payment is already matched to another statement line');
          }
          if (round(toNumber(line.amount)) !== round(toNumber(paymentRow.amount))) {
            throw badRequest('The statement amount does not match the payment', {
              paymentId: ['Mark the line as an exception if the amounts legitimately differ'],
            });
          }
          status = 'matched';
          matchedPaymentId = input.paymentId;
        } else if (input.exceptionReason) {
          status = 'exception';
          exceptionReason = input.exceptionReason;
        }

        await client.query(
          `UPDATE fee_reconciliation_lines SET
             status = $4, matched_payment_id = $5, exception_reason = $6
           WHERE school_id = $1 AND batch_id = $2 AND id = $3`,
          [schoolId, id, lineId, status, matchedPaymentId, exceptionReason],
        );
        await refreshBatchStatus(client, schoolId, id);
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.reconciliation_line_matched',
          entityType: 'fee_reconciliation_line',
          entityId: lineId,
          outcome: 'success',
          before: { status: line.status },
          after: { status, paymentId: matchedPaymentId, exceptionReason },
          ...requestMeta(request),
        });
        return { id: lineId, status };
      });
      return result;
    },
  );

  app.delete(
    '/api/schools/:schoolId/fees/reconciliation/batches/:id/lines/:lineId',
    { preHandler: requirePermission('fees.reconciliation.manage') },
    async (request, reply) => {
      const { schoolId, id, lineId } = parseInput(lineParams, request.params);
      const actor = getActor(request);
      await withTransaction(async (client) => {
        const batch = await client.query<{ status: ReconciliationBatch['status'] }>(
          `SELECT status FROM fee_reconciliation_batches
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        if (!batch.rows[0]) throw notFound('Reconciliation batch not found');
        if (batch.rows[0].status === 'closed') throw conflict('A closed batch cannot be edited');
        const { rowCount } = await client.query(
          `DELETE FROM fee_reconciliation_lines
           WHERE school_id = $1 AND batch_id = $2 AND id = $3`,
          [schoolId, id, lineId],
        );
        if (!rowCount) throw notFound('Statement line not found');
        await refreshBatchStatus(client, schoolId, id);
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.reconciliation_line_deleted',
          entityType: 'fee_reconciliation_line',
          entityId: lineId,
          outcome: 'success',
          ...requestMeta(request),
        });
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/schools/:schoolId/fees/reconciliation/batches/:id/close',
    { preHandler: requirePermission('fees.reconciliation.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(
        z.object({ note: z.string().trim().max(1000).optional() }),
        request.body ?? {},
      );
      const actor = getActor(request);
      const result = await withTransaction(async (client) => {
        const batch = await client.query<{ status: ReconciliationBatch['status']; notes: string | null }>(
          `SELECT status, notes FROM fee_reconciliation_batches
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = batch.rows[0];
        if (!row) throw notFound('Reconciliation batch not found');
        if (row.status === 'closed') throw conflict('This batch is already closed');
        const unmatched = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM fee_reconciliation_lines
           WHERE school_id = $1 AND batch_id = $2 AND status = 'unmatched'`,
          [schoolId, id],
        );
        if (toNumber(unmatched.rows[0]?.count) > 0) {
          throw conflict('Match or mark every statement line as an exception before closing');
        }
        await client.query(
          `UPDATE fee_reconciliation_batches SET
             status = 'closed', closed_by = $3, closed_at = now(),
             notes = CASE WHEN $4::text IS NULL THEN notes
                          WHEN notes IS NULL THEN $4::text
                          ELSE notes || E'\n' || $4::text END
           WHERE school_id = $1 AND id = $2`,
          [schoolId, id, actor.userId, input.note ?? null],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.reconciliation_batch_closed',
          entityType: 'fee_reconciliation_batch',
          entityId: id,
          outcome: 'success',
          before: { status: row.status },
          after: { status: 'closed', note: input.note ?? null },
          ...requestMeta(request),
        });
        return { id, status: 'closed' };
      });
      return result;
    },
  );

  app.get(
    '/api/schools/:schoolId/fees/reconciliation/payments',
    { preHandler: requirePermission('fees.reconciliation.manage') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(paymentQuery, request.query);
      const params: unknown[] = [schoolId];
      const filters = [`p.school_id = $1`, `p.status = 'recorded'`];
      if (query.search) {
        params.push(`%${query.search}%`);
        filters.push(
          `(p.receipt_number ILIKE $${params.length} OR p.reference ILIKE $${params.length}
            OR s.admission_number ILIKE $${params.length})`,
        );
      }
      if (query.from) {
        params.push(query.from);
        filters.push(`p.paid_on >= $${params.length}::date`);
      }
      if (query.to) {
        params.push(query.to);
        filters.push(`p.paid_on <= $${params.length}::date`);
      }
      const { rows } = await getPool().query<{
        id: string;
        receipt_number: string;
        student_name: string;
        admission_number: string;
        amount: string;
        method: string;
        reference: string | null;
        paid_on: string;
        matched: boolean;
      }>(
        `SELECT p.id, p.receipt_number,
                concat_ws(' ', s.first_name, s.middle_name, s.last_name) AS student_name,
                s.admission_number, p.amount, p.method, p.reference, p.paid_on,
                EXISTS (
                  SELECT 1 FROM fee_reconciliation_lines l
                  WHERE l.school_id = p.school_id AND l.matched_payment_id = p.id
                ) AS matched
         FROM payments p
         JOIN students s ON s.id = p.student_id AND s.school_id = p.school_id
         WHERE ${filters.join(' AND ')}
         ORDER BY p.paid_on DESC, p.created_at DESC
         LIMIT 200`,
        params,
      );
      return {
        items: rows.map((row) => ({
          id: row.id,
          receiptNumber: row.receipt_number,
          studentName: row.student_name,
          admissionNumber: row.admission_number,
          amount: toNumber(row.amount),
          method: row.method,
          reference: row.reference,
          paidOn: toIsoDate(row.paid_on),
          matched: row.matched,
        })),
      };
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

interface BatchRow {
  id: string;
  reference: string;
  source: string;
  statement_from: string | null;
  statement_to: string | null;
  status: ReconciliationBatch['status'];
  opening_balance: string | null;
  closing_balance: string | null;
  notes: string | null;
  created_at: Date;
  matched_count: string;
  unmatched_count: string;
  exception_count: string;
  matched_total: string;
}

interface LineRow {
  id: string;
  line_no: number;
  paid_on: string;
  amount: string;
  reference: string | null;
  method: ReconciliationLine['method'];
  status: ReconciliationLine['status'];
  matched_payment_id: string | null;
  matched_receipt_number: string | null;
  exception_reason: string | null;
}

const batchColumns = `
  b.id, b.reference, b.source, b.statement_from, b.statement_to, b.status,
  b.opening_balance, b.closing_balance, b.notes, b.created_at,
  (SELECT count(*) FROM fee_reconciliation_lines l
   WHERE l.school_id = b.school_id AND l.batch_id = b.id AND l.status = 'matched')::text
    AS matched_count,
  (SELECT count(*) FROM fee_reconciliation_lines l
   WHERE l.school_id = b.school_id AND l.batch_id = b.id AND l.status = 'unmatched')::text
    AS unmatched_count,
  (SELECT count(*) FROM fee_reconciliation_lines l
   WHERE l.school_id = b.school_id AND l.batch_id = b.id AND l.status = 'exception')::text
    AS exception_count,
  (SELECT COALESCE(sum(l.amount), 0) FROM fee_reconciliation_lines l
   WHERE l.school_id = b.school_id AND l.batch_id = b.id AND l.status = 'matched')::text
    AS matched_total`;

const lineSelect = `
  SELECT l.id, l.line_no, l.paid_on, l.amount, l.reference, l.method, l.status,
         l.matched_payment_id, p.receipt_number AS matched_receipt_number, l.exception_reason
  FROM fee_reconciliation_lines l
  LEFT JOIN payments p ON p.id = l.matched_payment_id AND p.school_id = l.school_id`;

function toBatch(row: BatchRow & { line_count: string }): ReconciliationBatch {
  return {
    id: row.id,
    reference: row.reference,
    source: row.source,
    statementFrom: row.statement_from ? toIsoDate(row.statement_from) : null,
    statementTo: row.statement_to ? toIsoDate(row.statement_to) : null,
    status: row.status,
    openingBalance: row.opening_balance === null ? null : toNumber(row.opening_balance),
    closingBalance: row.closing_balance === null ? null : toNumber(row.closing_balance),
    notes: row.notes,
    lineCount: toNumber(row.line_count),
    matchedCount: toNumber(row.matched_count),
    unmatchedCount: toNumber(row.unmatched_count),
    exceptionCount: toNumber(row.exception_count),
    matchedTotal: toNumber(row.matched_total),
    createdAt: toIsoDateTime(row.created_at),
  };
}

function toLine(row: LineRow): ReconciliationLine {
  return {
    id: row.id,
    lineNo: row.line_no,
    paidOn: toIsoDate(row.paid_on),
    amount: toNumber(row.amount),
    reference: row.reference,
    method: row.method,
    status: row.status,
    matchedPaymentId: row.matched_payment_id,
    matchedReceiptNumber: row.matched_receipt_number,
    exceptionReason: row.exception_reason,
  };
}

async function refreshBatchStatus(
  client: Pick<pg.PoolClient, 'query'>,
  schoolId: string,
  batchId: string,
): Promise<void> {
  await client.query(
    `UPDATE fee_reconciliation_batches SET status = CASE
       WHEN status = 'closed' THEN 'closed'
       WHEN NOT EXISTS (
         SELECT 1 FROM fee_reconciliation_lines l
         WHERE l.school_id = $1 AND l.batch_id = $2 AND l.status = 'unmatched'
       ) AND EXISTS (
         SELECT 1 FROM fee_reconciliation_lines l
         WHERE l.school_id = $1 AND l.batch_id = $2
       ) THEN 'balanced'
       ELSE 'draft'
     END
     WHERE school_id = $1 AND id = $2`,
    [schoolId, batchId],
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
