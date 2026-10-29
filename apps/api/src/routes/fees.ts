import { fullName } from '@erp/core';
import {
  chargeGenerateInput,
  chargeInput,
  chargeUpdate,
  feeHeadInput,
  feeHeadUpdate,
  feeStructureInput,
  feeStructureUpdate,
  paymentInput,
  refundInput,
  refundReviewInput,
  uuid,
  type FeeHead,
  type FeeLedger,
  type FeeOverview,
  type FeeStructure,
  type PaymentRecord,
  type RefundRecord,
  type StudentCharge,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { recordActivity, recordAudit } from '../lib/audit';
import { badRequest, conflict, notFound, parseInput } from '../lib/errors';
import { assertGuardianLinked } from '../lib/portal';
import { idempotentRoute } from '../lib/idempotency';
import { toIsoDate, toIsoDateTime, toNumber } from '../lib/format';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const studentParams = z.object({ schoolId: uuid, studentId: uuid });
const refundParams = z.object({ schoolId: uuid, id: uuid });

const listQuery = z.object({
  academicYearId: uuid.optional(),
  studentId: uuid.optional(),
  sectionId: uuid.optional(),
  status: z.enum(['paid', 'partial', 'unpaid']).optional(),
});
const structureQuery = z.object({
  academicYearId: uuid.optional(),
  classId: uuid.optional(),
});
const paymentQuery = z.object({
  academicYearId: uuid.optional(),
  studentId: uuid.optional(),
});
const refundQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

/**
 * Fee heads, class structures, student charges, receipts and refunds.
 *
 * All money is NUMERIC in PostgreSQL. Balances are derived from the ledger
 * every time they are read; no stored balance can drift from the payments.
 */
export async function registerFeeRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------- fee heads ------------------------------ */

  app.get(
    '/api/schools/:schoolId/fee-heads',
    { preHandler: requirePermission('fees.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        code: string;
        name: string;
        description: string | null;
        status: 'active' | 'inactive';
      }>(
        `SELECT id, code, name, description, status FROM fee_heads
         WHERE school_id = $1 ORDER BY name`,
        [schoolId],
      );
      return { items: rows satisfies FeeHead[] };
    },
  );

  app.post(
    '/api/schools/:schoolId/fee-heads',
    { preHandler: requirePermission('fees.charge.create') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(feeHeadInput, request.body);

      const head = await withTransaction(async (client) => {
        const { rows } = await client.query<{
          id: string;
          code: string;
          name: string;
          description: string | null;
          status: 'active' | 'inactive';
        }>(
          `INSERT INTO fee_heads (school_id, code, name, description, status)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, code, name, description, status`,
          [schoolId, input.code, input.name, input.description ?? null, input.status],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.head_created',
          entityType: 'fee_head',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: input,
          ...requestMeta(request),
        });
        return rows[0]!;
      });

      return reply.status(201).send(head);
    },
  );

  app.patch(
    '/api/schools/:schoolId/fee-heads/:id',
    { preHandler: requirePermission('fees.charge.create') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(feeHeadUpdate, request.body);

      return withTransaction(async (client) => {
        const existing = await client.query<{
          id: string;
          code: string;
          name: string;
          description: string | null;
          status: 'active' | 'inactive';
        }>(
          'SELECT id, code, name, description, status FROM fee_heads WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Fee head not found');

        const { rows } = await client.query<{
          id: string;
          code: string;
          name: string;
          description: string | null;
          status: 'active' | 'inactive';
        }>(
          `UPDATE fee_heads SET code = $3, name = $4, description = $5, status = $6
           WHERE school_id = $1 AND id = $2
           RETURNING id, code, name, description, status`,
          [
            schoolId,
            id,
            input.code ?? row.code,
            input.name ?? row.name,
            input.description === undefined ? row.description : input.description,
            input.status ?? row.status,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.head_updated',
          entityType: 'fee_head',
          entityId: id,
          outcome: 'success',
          before: row,
          after: input,
          ...requestMeta(request),
        });
        return rows[0]!;
      });
    },
  );

  /* ------------------------------- structures ------------------------------ */

  app.get(
    '/api/schools/:schoolId/fee-structures',
    { preHandler: requirePermission('fees.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(structureQuery, request.query);
      const params: unknown[] = [schoolId];
      const conditions = ['fs.school_id = $1'];
      if (query.academicYearId) {
        params.push(query.academicYearId);
        conditions.push(`fs.academic_year_id = $${params.length}`);
      }
      if (query.classId) {
        params.push(query.classId);
        conditions.push(`fs.class_id = $${params.length}`);
      }

      const { rows } = await getPool().query<{
        id: string;
        academic_year_id: string;
        class_id: string;
        class_name: string;
        fee_head_id: string;
        fee_head_name: string;
        amount: string;
        due_on: string | null;
      }>(
        `SELECT fs.id, fs.academic_year_id, fs.class_id, c.name AS class_name,
                fs.fee_head_id, fh.name AS fee_head_name, fs.amount, fs.due_on
         FROM fee_structures fs
         JOIN classes c ON c.id = fs.class_id AND c.school_id = fs.school_id
         JOIN fee_heads fh ON fh.id = fs.fee_head_id AND fh.school_id = fs.school_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY c.grade_order NULLS LAST, fh.name`,
        params,
      );

      return {
        items: rows.map(
          (row): FeeStructure => ({
            id: row.id,
            academicYearId: row.academic_year_id,
            classId: row.class_id,
            className: row.class_name,
            feeHeadId: row.fee_head_id,
            feeHeadName: row.fee_head_name,
            amount: toNumber(row.amount),
            dueOn: row.due_on ? toIsoDate(row.due_on) : null,
          }),
        ),
      };
    },
  );

  app.post(
    '/api/schools/:schoolId/fee-structures',
    { preHandler: requirePermission('fees.charge.create') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(feeStructureInput, request.body);

      const structure = await withTransaction(async (client) => {
        await assertYearClassHead(client, schoolId, input.academicYearId, input.classId, input.feeHeadId);
        const { rows } = await client.query<{
          id: string;
          academic_year_id: string;
          class_id: string;
          class_name: string;
          fee_head_id: string;
          fee_head_name: string;
          amount: string;
          due_on: string | null;
        }>(
          `WITH inserted AS (
             INSERT INTO fee_structures
               (school_id, academic_year_id, class_id, fee_head_id, amount, due_on)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *
           )
           SELECT i.id, i.academic_year_id, i.class_id, c.name AS class_name,
                  i.fee_head_id, fh.name AS fee_head_name, i.amount, i.due_on
           FROM inserted i
           JOIN classes c ON c.id = i.class_id
           JOIN fee_heads fh ON fh.id = i.fee_head_id`,
          [
            schoolId,
            input.academicYearId,
            input.classId,
            input.feeHeadId,
            input.amount,
            input.dueOn ?? null,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.structure_created',
          entityType: 'fee_structure',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: input,
          ...requestMeta(request),
        });
        return mapStructure(rows[0]!);
      });

      return reply.status(201).send(structure);
    },
  );

  app.patch(
    '/api/schools/:schoolId/fee-structures/:id',
    { preHandler: requirePermission('fees.charge.create') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(feeStructureUpdate, request.body);

      return withTransaction(async (client) => {
        const existing = await client.query<{
          id: string;
          amount: string;
          due_on: string | null;
        }>(
          'SELECT id, amount, due_on FROM fee_structures WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Fee structure not found');

        const { rows } = await client.query<{
          id: string;
          academic_year_id: string;
          class_id: string;
          class_name: string;
          fee_head_id: string;
          fee_head_name: string;
          amount: string;
          due_on: string | null;
        }>(
          `WITH updated AS (
             UPDATE fee_structures
             SET amount = $3, due_on = $4
             WHERE school_id = $1 AND id = $2
             RETURNING *
           )
           SELECT u.id, u.academic_year_id, u.class_id, c.name AS class_name,
                  u.fee_head_id, fh.name AS fee_head_name, u.amount, u.due_on
           FROM updated u
           JOIN classes c ON c.id = u.class_id
           JOIN fee_heads fh ON fh.id = u.fee_head_id`,
          [
            schoolId,
            id,
            input.amount ?? row.amount,
            input.dueOn === undefined ? row.due_on : input.dueOn,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.structure_updated',
          entityType: 'fee_structure',
          entityId: id,
          outcome: 'success',
          before: row,
          after: input,
          ...requestMeta(request),
        });
        return mapStructure(rows[0]!);
      });
    },
  );

  /* --------------------------------- charges -------------------------------- */

  app.get(
    '/api/schools/:schoolId/fees/charges',
    { preHandler: requirePermission('fees.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(listQuery, request.query);
      const params: unknown[] = [schoolId];
      const conditions = ['ch.school_id = $1'];
      if (query.academicYearId) {
        params.push(query.academicYearId);
        conditions.push(`ch.academic_year_id = $${params.length}`);
      }
      if (query.studentId) {
        params.push(query.studentId);
        conditions.push(`ch.student_id = $${params.length}`);
      }
      if (query.sectionId) {
        params.push(query.sectionId);
        conditions.push(
          `EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = ch.student_id
                   AND e.school_id = ch.school_id AND e.section_id = $${params.length}
                   AND e.enrollment_status = 'active')`,
        );
      }

      const { rows } = await getPool().query<ChargeRow>(
        `${chargeSelect} WHERE ${conditions.join(' AND ')}
         ORDER BY ch.due_on, st.first_name, fh.name`,
        params,
      );

      const items = rows.map(mapCharge);
      return {
        items: query.status ? items.filter((item) => item.status === query.status) : items,
      };
    },
  );

  app.post(
    '/api/schools/:schoolId/fees/charges',
    { preHandler: requirePermission('fees.charge.create') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(chargeInput, request.body);
      if (input.concessionAmount > input.amount) {
        throw badRequest('The concession cannot exceed the charge amount', {
          concessionAmount: ['Enter a concession less than or equal to the amount'],
        });
      }

      const charge = await withTransaction(async (client) => {
        await assertStudentYearHead(client, schoolId, input.studentId, input.academicYearId, input.feeHeadId);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO student_charges
             (school_id, student_id, academic_year_id, fee_head_id, description,
              amount, concession_amount, concession_reason, due_on, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            schoolId,
            input.studentId,
            input.academicYearId,
            input.feeHeadId,
            input.description,
            input.amount,
            input.concessionAmount,
            input.concessionReason ?? null,
            input.dueOn,
            actor.userId,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.charge_created',
          entityType: 'student_charge',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: { ...input, netAmount: input.amount - input.concessionAmount },
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });

      const { rows } = await getPool().query<ChargeRow>(`${chargeSelect} WHERE ch.id = $1`, [charge]);
      return reply.status(201).send(mapCharge(rows[0]!));
    },
  );

  app.patch(
    '/api/schools/:schoolId/fees/charges/:id',
    { preHandler: requirePermission('fees.charge.create') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(chargeUpdate, request.body);

      await withTransaction(async (client) => {
        const existing = await client.query<{
          id: string;
          description: string;
          amount: string;
          concession_amount: string;
          write_off_amount: string;
          concession_reason: string | null;
          due_on: string;
        }>(
          `SELECT id, description, amount, concession_amount, write_off_amount,
                  concession_reason, due_on
           FROM student_charges WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Charge not found');
        if (
          Number(input.concessionAmount ?? row.concession_amount) + Number(row.write_off_amount) >
          Number(row.amount)
        ) {
          throw badRequest('The concession cannot exceed the charge amount', {
            concessionAmount: ['Enter a concession less than or equal to the amount'],
          });
        }

        await client.query(
          `UPDATE student_charges
           SET description = $3, concession_amount = $4, concession_reason = $5, due_on = $6
           WHERE school_id = $1 AND id = $2`,
          [
            schoolId,
            id,
            input.description ?? row.description,
            input.concessionAmount ?? row.concession_amount,
            input.concessionReason === undefined ? row.concession_reason : input.concessionReason,
            input.dueOn ?? row.due_on,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.charge_updated',
          entityType: 'student_charge',
          entityId: id,
          outcome: 'success',
          before: row,
          after: input,
          ...requestMeta(request),
        });
      });

      const { rows } = await getPool().query<ChargeRow>(`${chargeSelect} WHERE ch.id = $1`, [id]);
      return mapCharge(rows[0]!);
    },
  );

  app.post(
    '/api/schools/:schoolId/fees/charges/generate',
    { preHandler: requirePermission('fees.charge.create') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(chargeGenerateInput, request.body);

      const result = await withTransaction(async (client) => {
        const section = await client.query<{ id: string; class_id: string; class_name: string; name: string }>(
          `SELECT sec.id, sec.class_id, c.name AS class_name, sec.name
           FROM sections sec JOIN classes c ON c.id = sec.class_id AND c.school_id = sec.school_id
           WHERE sec.school_id = $1 AND sec.id = $2 AND sec.academic_year_id = $3`,
          [schoolId, input.sectionId, input.academicYearId],
        );
        const sectionRow = section.rows[0];
        if (!sectionRow) throw notFound('Section not found');

        const params: unknown[] = [schoolId, input.academicYearId, sectionRow.class_id];
        let headFilter = '';
        if (input.feeHeadIds && input.feeHeadIds.length > 0) {
          params.push(input.feeHeadIds);
          headFilter = `AND fs.fee_head_id = ANY($${params.length}::uuid[])`;
        }

        const structures = await client.query<{
          fee_head_id: string;
          fee_head_name: string;
          amount: string;
          due_on: string | null;
        }>(
          `SELECT fs.fee_head_id, fh.name AS fee_head_name, fs.amount, fs.due_on
           FROM fee_structures fs
           JOIN fee_heads fh ON fh.id = fs.fee_head_id AND fh.school_id = fs.school_id
           WHERE fs.school_id = $1 AND fs.academic_year_id = $2 AND fs.class_id = $3
             AND fh.status = 'active' ${headFilter}
           ORDER BY fh.name`,
          params,
        );
        if (structures.rows.length === 0) {
          throw badRequest('No fee structures are configured for this class and year', {
            sectionId: ['Add fee structures for the class first'],
          });
        }

        const students = await client.query<{ student_id: string }>(
          `SELECT e.student_id FROM enrollments e
           WHERE e.school_id = $1 AND e.section_id = $2
             AND e.academic_year_id = $3 AND e.enrollment_status = 'active'`,
          [schoolId, sectionRow.id, input.academicYearId],
        );

        let created = 0;
        let skipped = 0;
        for (const student of students.rows) {
          for (const structure of structures.rows) {
            const { rowCount } = await client.query(
              `INSERT INTO student_charges
                 (school_id, student_id, academic_year_id, fee_head_id, description,
                  amount, due_on, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (student_id, academic_year_id, fee_head_id) DO NOTHING`,
              [
                schoolId,
                student.student_id,
                input.academicYearId,
                structure.fee_head_id,
                `${structure.fee_head_name} fee`,
                structure.amount,
                structure.due_on ?? input.dueOn,
                actor.userId,
              ],
            );
            if (rowCount === 1) created += 1;
            else skipped += 1;
          }
        }

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.charges_generated',
          entityType: 'section',
          entityId: sectionRow.id,
          outcome: 'success',
          after: {
            class: `${sectionRow.class_name} · ${sectionRow.name}`,
            created,
            skipped,
            academicYearId: input.academicYearId,
          },
          ...requestMeta(request),
        });
        if (created > 0) {
          await recordActivity(client, {
            schoolId,
            entityType: 'section',
            entityId: sectionRow.id,
            eventType: 'fees.charges_generated',
            actorUserId: actor.userId,
            summary: `${created} fee charges generated for ${sectionRow.class_name} · ${sectionRow.name}`,
          });
        }

        return { created, skipped };
      });

      return reply.status(result.created > 0 ? 201 : 200).send(result);
    },
  );

  /* --------------------------------- payments ------------------------------- */

  app.get(
    '/api/schools/:schoolId/fees/payments',
    { preHandler: requirePermission('fees.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(paymentQuery, request.query);
      const params: unknown[] = [schoolId];
      const conditions = ['p.school_id = $1'];
      if (query.academicYearId) {
        params.push(query.academicYearId);
        conditions.push(`p.academic_year_id = $${params.length}`);
      }
      if (query.studentId) {
        params.push(query.studentId);
        conditions.push(`p.student_id = $${params.length}`);
      }

      const { rows } = await getPool().query<PaymentRow>(
        `${paymentSelect} WHERE ${conditions.join(' AND ')}
         GROUP BY p.id, st.id, u.display_name
         ORDER BY p.paid_on DESC, p.created_at DESC`,
        params,
      );
      return { items: rows.map(mapPayment) };
    },
  );

  app.post(
    '/api/schools/:schoolId/fees/payments',
    { preHandler: requirePermission('fees.payment.verify') },
    idempotentRoute('POST /fees/payments', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(paymentInput, request.body);

      const paymentId = await withTransaction(async (client) => {
        await assertStudentYear(client, schoolId, input.studentId, input.academicYearId);

        // Lock the student's open charges so concurrent payments cannot
        // allocate more than the outstanding balance.
        const charges = await client.query<{
          id: string;
          fee_head_id: string;
          net: string;
          paid: string;
          due_on: string;
        }>(
          `SELECT ch.id, ch.fee_head_id,
                  (ch.amount - ch.concession_amount - ch.write_off_amount)::text AS net,
                  COALESCE((
                    SELECT sum(pa.amount) FROM payment_allocations pa
                    JOIN payments p ON p.id = pa.payment_id AND p.status = 'recorded'
                    WHERE pa.charge_id = ch.id
                  ), 0)::text AS paid,
                  ch.due_on
           FROM student_charges ch
           WHERE ch.school_id = $1 AND ch.student_id = $2 AND ch.academic_year_id = $3
           ORDER BY ch.due_on, ch.id
           FOR UPDATE`,
          [schoolId, input.studentId, input.academicYearId],
        );

        let allocations = input.allocations ?? [];
        if (allocations.length === 0) {
          let remaining = input.amount;
          allocations = [];
          for (const charge of charges.rows) {
            if (remaining <= 0) break;
            const outstanding = Math.max(
              0,
              Math.round((Number(charge.net) - Number(charge.paid)) * 100) / 100,
            );
            if (outstanding <= 0) continue;
            const amount = Math.min(outstanding, remaining);
            allocations.push({ chargeId: charge.id, amount });
            remaining = Math.round((remaining - amount) * 100) / 100;
          }
        } else {
          const total = allocations.reduce((sum, entry) => sum + entry.amount, 0);
          if (Math.round(total * 100) / 100 > Math.round(input.amount * 100) / 100) {
            throw badRequest('Allocations cannot exceed the payment amount', {
              allocations: ['Reduce the allocated amounts'],
            });
          }
          const byId = new Map(charges.rows.map((charge) => [charge.id, charge]));
          const seen = new Set<string>();
          for (const allocation of allocations) {
            if (seen.has(allocation.chargeId)) {
              throw badRequest('Each charge can be allocated only once', {
                allocations: ['Remove the duplicate charge'],
              });
            }
            seen.add(allocation.chargeId);
            const charge = byId.get(allocation.chargeId);
            if (!charge) {
              throw badRequest('Every allocation must belong to this student and academic year', {
                allocations: ['Choose charges from this student'],
              });
            }
            const outstanding =
              Math.round((Number(charge.net) - Number(charge.paid)) * 100) / 100;
            if (Math.round(allocation.amount * 100) / 100 > outstanding) {
              throw badRequest('An allocation exceeds the outstanding balance of its charge', {
                allocations: ['Reduce the allocated amount'],
              });
            }
          }
        }

        const { rows: counter } = await client.query<{ value: string }>(
          `INSERT INTO school_counters (school_id, name, value)
           VALUES ($1, 'receipt_number', 1)
           ON CONFLICT (school_id, name)
           DO UPDATE SET value = school_counters.value + 1
           RETURNING value`,
          [schoolId],
        );
        const receiptNumber = `RCPT-${String(counter[0]!.value).padStart(6, '0')}`;

        const payment = await client.query<{ id: string }>(
          `INSERT INTO payments
             (school_id, student_id, academic_year_id, receipt_number, amount, method,
              reference, paid_on, notes, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            schoolId,
            input.studentId,
            input.academicYearId,
            receiptNumber,
            input.amount,
            input.method,
            input.reference ?? null,
            input.paidOn,
            input.notes ?? null,
            actor.userId,
          ],
        );
        const id = payment.rows[0]!.id;

        for (const allocation of allocations) {
          await client.query(
            `INSERT INTO payment_allocations (school_id, payment_id, charge_id, amount)
             VALUES ($1, $2, $3, $4)`,
            [schoolId, id, allocation.chargeId, allocation.amount],
          );
        }

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.payment_recorded',
          entityType: 'payment',
          entityId: id,
          outcome: 'success',
          after: {
            receiptNumber,
            studentId: input.studentId,
            amount: input.amount,
            method: input.method,
            allocations,
          },
          ...requestMeta(request),
        });
        await recordActivity(client, {
          schoolId,
          entityType: 'student',
          entityId: input.studentId,
          eventType: 'fees.payment_recorded',
          actorUserId: actor.userId,
          summary: `Payment ${receiptNumber} recorded for ${formatMoney(input.amount)}`,
        });

        return id;
      });

      const { rows } = await getPool().query<PaymentRow>(
        `${paymentSelect} WHERE p.id = $1 GROUP BY p.id, st.id, u.display_name`,
        [paymentId],
      );
      return reply.status(201).send(mapPayment(rows[0]!));
    }),
  );

  /* --------------------------------- refunds -------------------------------- */

  app.get(
    '/api/schools/:schoolId/fees/refunds',
    { preHandler: requirePermission('fees.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(refundQuery, request.query);
      const params: unknown[] = [schoolId];
      let filter = '';
      if (query.status) {
        params.push(query.status);
        filter = `AND r.status = $${params.length}`;
      }
      const { rows } = await getPool().query<RefundRow>(
        `${refundSelect} WHERE r.school_id = $1 ${filter} ORDER BY r.requested_at DESC`,
        params,
      );
      return { items: rows.map(mapRefund) };
    },
  );

  app.post(
    '/api/schools/:schoolId/fees/refunds',
    { preHandler: requirePermission('fees.payment.verify') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(refundInput, request.body);

      const refundId = await withTransaction(async (client) => {
        const payment = await client.query<{
          id: string;
          amount: string;
          status: string;
          student_id: string;
          receipt_number: string;
        }>(
          `SELECT id, amount, status, student_id, receipt_number FROM payments
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, input.paymentId],
        );
        const row = payment.rows[0];
        if (!row) throw notFound('Payment not found');
        if (row.status !== 'recorded') {
          throw badRequest('This payment has been reversed and cannot be refunded');
        }

        const refunded = await client.query<{ total: string; pending: string }>(
          `SELECT
             COALESCE(sum(amount) FILTER (WHERE status = 'approved'), 0)::text AS total,
             COALESCE(sum(amount) FILTER (WHERE status = 'pending'), 0)::text AS pending
           FROM refunds WHERE school_id = $1 AND payment_id = $2`,
          [schoolId, input.paymentId],
        );
        const already = Number(refunded.rows[0]!.total) + Number(refunded.rows[0]!.pending);
        if (Math.round((already + input.amount) * 100) / 100 > Number(row.amount)) {
          throw badRequest('The refund exceeds the refundable amount of this payment', {
            amount: [`At most ${formatMoney(Number(row.amount) - already)} can be requested`],
          });
        }

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO refunds (school_id, payment_id, amount, reason, requested_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [schoolId, input.paymentId, input.amount, input.reason, actor.userId],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'fees.refund_requested',
          entityType: 'refund',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: { receiptNumber: row.receipt_number, amount: input.amount },
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });

      const { rows } = await getPool().query<RefundRow>(`${refundSelect} WHERE r.id = $1`, [refundId]);
      return reply.status(201).send(mapRefund(rows[0]!));
    },
  );

  app.post(
    '/api/schools/:schoolId/fees/refunds/:id/review',
    { preHandler: requirePermission('fees.refund.approve') },
    async (request) => {
      const { schoolId, id } = parseInput(refundParams, request.params);
      const actor = getActor(request);
      const input = parseInput(refundReviewInput, request.body);

      const refund = await withTransaction(async (client) => {
        const locked = await client.query<{
          id: string;
          payment_id: string;
          amount: string;
          status: string;
          requested_by: string;
        }>(
          `SELECT id, payment_id, amount, status, requested_by FROM refunds
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = locked.rows[0];
        if (!row) throw notFound('Refund not found');
        if (row.status !== 'pending') {
          throw conflict('This refund has already been reviewed', 'already_reviewed');
        }
        if (row.requested_by === actor.userId) {
          throw conflict('A different approver must review your own refund request', 'self_approval');
        }

        if (input.decision === 'approve') {
          const payment = await client.query<{ amount: string }>(
            'SELECT amount FROM payments WHERE school_id = $1 AND id = $2 FOR UPDATE',
            [schoolId, row.payment_id],
          );
          const approved = await client.query<{ total: string }>(
            `SELECT COALESCE(sum(amount), 0)::text AS total FROM refunds
             WHERE school_id = $1 AND payment_id = $2 AND status = 'approved'`,
            [schoolId, row.payment_id],
          );
          if (
            Math.round((Number(approved.rows[0]!.total) + Number(row.amount)) * 100) / 100 >
            Number(payment.rows[0]!.amount)
          ) {
            throw badRequest('Approving this refund would exceed the payment amount');
          }
        }

        await client.query(
          `UPDATE refunds
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
            input.decision === 'approve' ? 'fees.refund_approved' : 'fees.refund_rejected',
          entityType: 'refund',
          entityId: id,
          outcome: 'success',
          after: { decision: input.decision, amount: toNumber(row.amount), note: input.note ?? null },
          ...requestMeta(request),
        });
        return loadRefund(client, schoolId, id);
      });

      return refund;
    },
  );

  /* ---------------------------------- ledger -------------------------------- */

  app.get(
    '/api/schools/:schoolId/fees/overview',
    { preHandler: requirePermission('fees.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(z.object({ academicYearId: uuid.optional() }), request.query);
      const params: unknown[] = [schoolId];
      const yearFilter = query.academicYearId
        ? (params.push(query.academicYearId), `AND ch.academic_year_id = $${params.length}`)
        : '';

      const charges = await getPool().query<{
        charged: string;
        concession: string;
        write_off: string;
        paid: string;
        count: string;
        paid_count: string;
        partial_count: string;
        unpaid_count: string;
      }>(
        `WITH charge_rows AS (
           SELECT ch.id, (ch.amount - ch.concession_amount - ch.write_off_amount)::numeric AS net,
                  ch.amount, ch.concession_amount, ch.write_off_amount,
                  COALESCE((
                    SELECT sum(pa.amount) FROM payment_allocations pa
                    JOIN payments p ON p.id = pa.payment_id AND p.status = 'recorded'
                    WHERE pa.charge_id = ch.id
                  ), 0)::numeric AS paid
           FROM student_charges ch
           WHERE ch.school_id = $1 ${yearFilter}
         )
         SELECT COALESCE(sum(amount), 0)::text AS charged,
                COALESCE(sum(concession_amount), 0)::text AS concession,
                COALESCE(sum(write_off_amount), 0)::text AS write_off,
                COALESCE(sum(paid), 0)::text AS paid,
                count(*)::text AS count,
                count(*) FILTER (WHERE paid >= net)::text AS paid_count,
                count(*) FILTER (WHERE paid > 0 AND paid < net)::text AS partial_count,
                count(*) FILTER (WHERE paid = 0)::text AS unpaid_count
         FROM charge_rows`,
        params,
      );

      const refunds = await getPool().query<{ total: string }>(
        `SELECT COALESCE(sum(r.amount), 0)::text AS total
         FROM refunds r
         JOIN payments p ON p.id = r.payment_id
         WHERE r.school_id = $1 AND r.status = 'approved'
         ${query.academicYearId ? `AND p.academic_year_id = $2` : ''}`,
        query.academicYearId ? [schoolId, query.academicYearId] : [schoolId],
      );

      const row = charges.rows[0]!;
      const totalCharged = toNumber(row.charged);
      const totalConcession = toNumber(row.concession);
      const totalWriteOff = toNumber(row.write_off);
      const totalCollected = toNumber(row.paid);
      const totalRefunded = toNumber(refunds.rows[0]?.total);
      const overview: FeeOverview = {
        totalCharged,
        totalConcession,
        totalWriteOff,
        totalCollected,
        totalRefunded,
        totalOutstanding:
          Math.round(
            (totalCharged - totalConcession - totalWriteOff - totalCollected + totalRefunded) *
              100,
          ) / 100,
        chargeCount: toNumber(row.count),
        paidCount: toNumber(row.paid_count),
        partialCount: toNumber(row.partial_count),
        unpaidCount: toNumber(row.unpaid_count),
      };
      return overview;
    },
  );

  app.get(
    '/api/schools/:schoolId/fees/students/:studentId/ledger',
    { preHandler: requirePermission('fees.view') },
    async (request) => {
      const { schoolId, studentId } = parseInput(studentParams, request.params);
      return loadLedger(getPool(), schoolId, studentId, null);
    },
  );

  /* ------------------------------ guardian portal --------------------------- */

  app.get(
    '/api/schools/:schoolId/portal/children/:studentId/fees',
    { preHandler: requirePermission('guardian.student.view') },
    async (request) => {
      const { schoolId, studentId } = parseInput(studentParams, request.params);
      const actor = getActor(request);
      await assertGuardianLinked(getPool(), schoolId, actor.userId, studentId);
      return loadLedger(getPool(), schoolId, studentId, null);
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

interface ChargeRow {
  id: string;
  student_id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string | null;
  admission_number: string;
  academic_year_id: string;
  fee_head_id: string;
  fee_head_name: string;
  description: string;
  amount: string;
  concession_amount: string;
  write_off_amount: string;
  paid: string;
  due_on: string;
}

const chargeSelect = `
  SELECT ch.id, ch.student_id, st.first_name, st.middle_name, st.last_name,
         st.admission_number, ch.academic_year_id, ch.fee_head_id,
         fh.name AS fee_head_name, ch.description, ch.amount, ch.concession_amount,
         ch.write_off_amount,
         COALESCE((
           SELECT sum(pa.amount) FROM payment_allocations pa
           JOIN payments p ON p.id = pa.payment_id AND p.status = 'recorded'
           WHERE pa.charge_id = ch.id
         ), 0)::text AS paid,
         ch.due_on
  FROM student_charges ch
  JOIN students st ON st.id = ch.student_id AND st.school_id = ch.school_id
  JOIN fee_heads fh ON fh.id = ch.fee_head_id AND fh.school_id = ch.school_id`;

function mapCharge(row: ChargeRow): StudentCharge {
  const amount = toNumber(row.amount);
  const concessionAmount = toNumber(row.concession_amount);
  const writeOffAmount = toNumber(row.write_off_amount);
  const paidAmount = toNumber(row.paid);
  const netAmount = Math.round((amount - concessionAmount - writeOffAmount) * 100) / 100;
  const balance = Math.round((netAmount - paidAmount) * 100) / 100;
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: fullName(row.first_name, row.middle_name, row.last_name),
    admissionNumber: row.admission_number,
    academicYearId: row.academic_year_id,
    feeHeadId: row.fee_head_id,
    feeHeadName: row.fee_head_name,
    description: row.description,
    amount,
    concessionAmount,
    writeOffAmount,
    netAmount,
    paidAmount,
    refundedAmount: 0,
    balance,
    dueOn: toIsoDate(row.due_on),
    status: balance <= 0 ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid',
  };
}

interface PaymentRow {
  id: string;
  receipt_number: string;
  student_id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string | null;
  admission_number: string;
  academic_year_id: string;
  amount: string;
  refunded: string;
  method: PaymentRecord['method'];
  reference: string | null;
  paid_on: string;
  notes: string | null;
  status: 'recorded' | 'reversed';
  recorded_by_name: string | null;
  created_at: Date | string;
  allocations: Array<{ chargeId: string; feeHeadName: string; amount: number | string }> | null;
}

const paymentSelect = `
  SELECT p.id, p.receipt_number, p.student_id, st.first_name, st.middle_name, st.last_name,
         st.admission_number, p.academic_year_id, p.amount,
         COALESCE((
           SELECT sum(r.amount) FROM refunds r
           WHERE r.payment_id = p.id AND r.status = 'approved'
         ), 0)::text AS refunded,
         p.method, p.reference, p.paid_on, p.notes, p.status,
         u.display_name AS recorded_by_name, p.created_at,
         COALESCE(
           jsonb_agg(jsonb_build_object(
             'chargeId', pa.charge_id,
             'feeHeadName', fh.name,
             'amount', pa.amount
           ) ORDER BY pa.created_at) FILTER (WHERE pa.id IS NOT NULL),
           '[]'::jsonb
         ) AS allocations
  FROM payments p
  JOIN students st ON st.id = p.student_id AND st.school_id = p.school_id
  LEFT JOIN users u ON u.id = p.recorded_by
  LEFT JOIN payment_allocations pa ON pa.payment_id = p.id AND pa.school_id = p.school_id
  LEFT JOIN student_charges ch ON ch.id = pa.charge_id AND ch.school_id = p.school_id
  LEFT JOIN fee_heads fh ON fh.id = ch.fee_head_id AND fh.school_id = p.school_id`;

function mapPayment(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    studentId: row.student_id,
    studentName: fullName(row.first_name, row.middle_name, row.last_name),
    admissionNumber: row.admission_number,
    academicYearId: row.academic_year_id,
    amount: toNumber(row.amount),
    refundedAmount: toNumber(row.refunded),
    method: row.method,
    reference: row.reference,
    paidOn: toIsoDate(row.paid_on),
    notes: row.notes,
    status: row.status,
    recordedByName: row.recorded_by_name,
    allocations: (row.allocations ?? []).map((entry) => ({
      chargeId: entry.chargeId,
      feeHeadName: entry.feeHeadName,
      amount: toNumber(entry.amount),
    })),
    createdAt: toIsoDateTime(row.created_at),
  };
}

interface RefundRow {
  id: string;
  payment_id: string;
  receipt_number: string;
  amount: string;
  reason: string;
  status: RefundRecord['status'];
  requested_by_name: string | null;
  requested_at: Date;
  reviewed_by_name: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  student_name: string;
}

const refundSelect = `
  SELECT r.id, r.payment_id, p.receipt_number, r.amount, r.reason, r.status,
         ru.display_name AS requested_by_name, r.requested_at,
         vu.display_name AS reviewed_by_name, r.reviewed_at, r.review_note,
         concat_ws(' ', st.first_name, st.middle_name, st.last_name) AS student_name
  FROM refunds r
  JOIN payments p ON p.id = r.payment_id AND p.school_id = r.school_id
  JOIN students st ON st.id = p.student_id AND st.school_id = p.school_id
  LEFT JOIN users ru ON ru.id = r.requested_by
  LEFT JOIN users vu ON vu.id = r.reviewed_by`;

function mapRefund(row: RefundRow): RefundRecord {
  return {
    id: row.id,
    paymentId: row.payment_id,
    receiptNumber: row.receipt_number,
    studentName: row.student_name,
    amount: toNumber(row.amount),
    reason: row.reason,
    status: row.status,
    requestedByName: row.requested_by_name,
    requestedAt: row.requested_at.toISOString(),
    reviewedByName: row.reviewed_by_name,
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
    reviewNote: row.review_note,
  };
}

async function loadRefund(
  client: Pick<pg.Pool, 'query'> | pg.PoolClient,
  schoolId: string,
  id: string,
): Promise<RefundRecord> {
  const { rows } = await client.query<RefundRow>(`${refundSelect} WHERE r.school_id = $1 AND r.id = $2`, [
    schoolId,
    id,
  ]);
  if (!rows[0]) throw notFound('Refund not found');
  return mapRefund(rows[0]);
}

async function loadLedger(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  studentId: string,
  academicYearId: string | null,
): Promise<FeeLedger> {
  const student = await client.query<{
    id: string;
    first_name: string;
    middle_name: string | null;
    last_name: string | null;
    admission_number: string;
    class_name: string | null;
    section_name: string | null;
    academic_year_id: string | null;
  }>(
    `SELECT st.id, st.first_name, st.middle_name, st.last_name, st.admission_number,
            c.name AS class_name, sec.name AS section_name, e.academic_year_id
     FROM students st
     LEFT JOIN LATERAL (
       SELECT e2.section_id, e2.academic_year_id FROM enrollments e2
       WHERE e2.student_id = st.id AND e2.enrollment_status = 'active'
       ORDER BY e2.starts_on DESC LIMIT 1
     ) e ON true
     LEFT JOIN sections sec ON sec.id = e.section_id
     LEFT JOIN classes c ON c.id = sec.class_id
     WHERE st.school_id = $1 AND st.id = $2`,
    [schoolId, studentId],
  );
  const studentRow = student.rows[0];
  if (!studentRow) throw notFound('Student not found');

  const yearId = academicYearId ?? studentRow.academic_year_id;
  const chargeParams: unknown[] = [schoolId, studentId];
  let chargeYear = '';
  if (yearId) {
    chargeParams.push(yearId);
    chargeYear = `AND ch.academic_year_id = $${chargeParams.length}`;
  }
  const charges = await client.query<ChargeRow>(
    `${chargeSelect} WHERE ch.school_id = $1 AND ch.student_id = $2 ${chargeYear}
     ORDER BY ch.due_on, fh.name`,
    chargeParams,
  );

  const paymentParams: unknown[] = [schoolId, studentId];
  let paymentYear = '';
  if (yearId) {
    paymentParams.push(yearId);
    paymentYear = `AND p.academic_year_id = $${paymentParams.length}`;
  }
  const payments = await client.query<PaymentRow>(
    `${paymentSelect} WHERE p.school_id = $1 AND p.student_id = $2 ${paymentYear}
     GROUP BY p.id, st.id, u.display_name
     ORDER BY p.paid_on DESC, p.created_at DESC`,
    paymentParams,
  );

  const chargeItems = charges.rows.map(mapCharge);
  const paymentItems = payments.rows.map(mapPayment);
  const totalCharged = round(chargeItems.reduce((sum, item) => sum + item.amount, 0));
  const totalConcession = round(
    chargeItems.reduce((sum, item) => sum + item.concessionAmount, 0),
  );
  const totalWriteOff = round(
    chargeItems.reduce((sum, item) => sum + item.writeOffAmount, 0),
  );
  const totalPaid = round(
    paymentItems
      .filter((payment) => payment.status === 'recorded')
      .reduce((sum, payment) => sum + payment.amount, 0),
  );
  const totalRefunded = round(
    paymentItems.reduce((sum, payment) => sum + payment.refundedAmount, 0),
  );

  return {
    studentId: studentRow.id,
    studentName: fullName(studentRow.first_name, studentRow.middle_name, studentRow.last_name),
    admissionNumber: studentRow.admission_number,
    className: studentRow.class_name,
    sectionName: studentRow.section_name,
    academicYearId: yearId,
    totalCharged,
    totalConcession,
    totalWriteOff,
    totalPaid,
    totalRefunded,
    balance: round(totalCharged - totalConcession - totalWriteOff - totalPaid + totalRefunded),
    charges: chargeItems,
    payments: paymentItems,
  };
}

async function assertYearClassHead(
  client: pg.PoolClient,
  schoolId: string,
  yearId: string,
  classId: string,
  headId: string,
): Promise<void> {
  const year = await client.query('SELECT 1 FROM academic_years WHERE school_id = $1 AND id = $2', [
    schoolId,
    yearId,
  ]);
  if (year.rowCount === 0) throw notFound('Academic year not found');
  const klass = await client.query('SELECT 1 FROM classes WHERE school_id = $1 AND id = $2', [
    schoolId,
    classId,
  ]);
  if (klass.rowCount === 0) throw notFound('Class not found');
  const head = await client.query('SELECT 1 FROM fee_heads WHERE school_id = $1 AND id = $2', [
    schoolId,
    headId,
  ]);
  if (head.rowCount === 0) throw notFound('Fee head not found');
}

async function assertStudentYear(
  client: pg.PoolClient,
  schoolId: string,
  studentId: string,
  yearId: string,
): Promise<void> {
  const result = await client.query(
    'SELECT 1 FROM students s JOIN academic_years y ON y.school_id = s.school_id WHERE s.school_id = $1 AND s.id = $2 AND y.id = $3',
    [schoolId, studentId, yearId],
  );
  if (result.rowCount === 0) throw notFound('Student or academic year not found');
}

async function assertStudentYearHead(
  client: pg.PoolClient,
  schoolId: string,
  studentId: string,
  yearId: string,
  headId: string,
): Promise<void> {
  await assertStudentYear(client, schoolId, studentId, yearId);
  const head = await client.query('SELECT 1 FROM fee_heads WHERE school_id = $1 AND id = $2', [
    schoolId,
    headId,
  ]);
  if (head.rowCount === 0) throw notFound('Fee head not found');
}

function mapStructure(row: {
  id: string;
  academic_year_id: string;
  class_id: string;
  class_name: string;
  fee_head_id: string;
  fee_head_name: string;
  amount: string;
  due_on: string | null;
}): FeeStructure {
  return {
    id: row.id,
    academicYearId: row.academic_year_id,
    classId: row.class_id,
    className: row.class_name,
    feeHeadId: row.fee_head_id,
    feeHeadName: row.fee_head_name,
    amount: toNumber(row.amount),
    dueOn: row.due_on ? toIsoDate(row.due_on) : null,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(value);
}
