import {
  safeguardingCaseInput,
  safeguardingCaseUpdate,
  safeguardingNoteInput,
  uuid,
  type SafeguardingCaseDetail,
  type SafeguardingCaseSummary,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, conflict, notFound, parseInput } from '../lib/errors';
import { fullName } from '@erp/core';
import { toIsoDate, toIsoDateTime } from '../lib/format';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const listQuery = z.object({
  status: z.enum(['open', 'monitoring', 'closed']).optional(),
  studentId: uuid.optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
});

/**
 * Safeguarding cases are deliberately separate from ordinary student records.
 * Every read is gated by `safeguarding.case.view`, every mutation is audited,
 * and note text is never copied into the audit payload.
 */
export async function registerSafeguardingRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/schools/:schoolId/safeguarding',
    { preHandler: requirePermission('safeguarding.case.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(listQuery, request.query);
      const params: unknown[] = [schoolId];
      const conditions = ['c.school_id = $1'];
      if (query.status) {
        params.push(query.status);
        conditions.push(`c.status = $${params.length}`);
      }
      if (query.severity) {
        params.push(query.severity);
        conditions.push(`c.severity = $${params.length}`);
      }
      if (query.studentId) {
        params.push(query.studentId);
        conditions.push(`c.student_id = $${params.length}`);
      }

      const { rows } = await getPool().query<CaseRow>(
        `${caseSelect} WHERE ${conditions.join(' AND ')}
         ORDER BY (c.status = 'open') DESC, c.opened_on DESC, c.created_at DESC`,
        params,
      );
      return { items: rows.map(mapCase) };
    },
  );

  app.get(
    '/api/schools/:schoolId/safeguarding/:id',
    { preHandler: requirePermission('safeguarding.case.view') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const { rows } = await getPool().query<CaseRow>(
        `${caseSelect} WHERE c.school_id = $1 AND c.id = $2`,
        [schoolId, id],
      );
      if (!rows[0]) throw notFound('Safeguarding case not found');

      const notes = await getPool().query<{
        id: string;
        note: string;
        author_name: string | null;
        created_at: Date;
      }>(
        `SELECT n.id, n.note, u.display_name AS author_name, n.created_at
         FROM safeguarding_notes n
         LEFT JOIN users u ON u.id = n.author_id
         WHERE n.school_id = $1 AND n.case_id = $2
         ORDER BY n.created_at`,
        [schoolId, id],
      );

      const detail: SafeguardingCaseDetail = {
        ...mapCase(rows[0]),
        notes: notes.rows.map((note) => ({
          id: note.id,
          note: note.note,
          authorName: note.author_name,
          createdAt: toIsoDateTime(note.created_at),
        })),
      };
      return detail;
    },
  );

  app.post(
    '/api/schools/:schoolId/safeguarding',
    { preHandler: requirePermission('safeguarding.case.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(safeguardingCaseInput, request.body);

      const created = await withTransaction(async (client) => {
        const student = await client.query(
          'SELECT 1 FROM students WHERE school_id = $1 AND id = $2',
          [schoolId, input.studentId],
        );
        if (student.rowCount === 0) {
          throw badRequest('Student not found', { studentId: ['Choose a student in this school'] });
        }
        const reference = await nextReference(client, schoolId);

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO safeguarding_cases
             (school_id, student_id, reference, category, severity, summary, opened_on, opened_by)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, current_date), $8)
           RETURNING id`,
          [
            schoolId,
            input.studentId,
            reference,
            input.category,
            input.severity,
            input.summary,
            input.openedOn ?? null,
            actor.userId,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'safeguarding.case_opened',
          entityType: 'safeguarding_case',
          entityId: rows[0]!.id,
          outcome: 'success',
          // The summary is not copied into the audit payload.
          after: {
            studentId: input.studentId,
            reference,
            category: input.category,
            severity: input.severity,
          },
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });

      const { rows } = await getPool().query<CaseRow>(
        `${caseSelect} WHERE c.school_id = $1 AND c.id = $2`,
        [schoolId, created],
      );
      return reply.status(201).send(mapCase(rows[0]!));
    },
  );

  app.patch(
    '/api/schools/:schoolId/safeguarding/:id',
    { preHandler: requirePermission('safeguarding.case.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(safeguardingCaseUpdate, request.body);

      await withTransaction(async (client) => {
        const existing = await client.query<{
          category: string;
          severity: string;
          summary: string;
          status: SafeguardingCaseSummary['status'];
          closed_on: string | null;
        }>(
          `SELECT category, severity, summary, status, closed_on
           FROM safeguarding_cases WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Safeguarding case not found');

        const status = input.status ?? row.status;
        let closedOn = input.closedOn === undefined ? row.closed_on : input.closedOn;
        if (status === 'closed' && !closedOn) closedOn = toIsoDate(new Date());
        if (status !== 'closed' && input.closedOn === undefined) closedOn = null;
        if (status !== 'closed' && input.closedOn === null) closedOn = null;

        await client.query(
          `UPDATE safeguarding_cases
           SET category = $3, severity = $4, summary = $5, status = $6, closed_on = $7
           WHERE school_id = $1 AND id = $2`,
          [
            schoolId,
            id,
            input.category ?? row.category,
            input.severity ?? row.severity,
            input.summary ?? row.summary,
            status,
            closedOn,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action:
            status !== row.status
              ? `safeguarding.case_${status}`
              : 'safeguarding.case_updated',
          entityType: 'safeguarding_case',
          entityId: id,
          outcome: 'success',
          before: {
            category: row.category,
            severity: row.severity,
            status: row.status,
            closedOn: row.closed_on,
          },
          after: {
            category: input.category ?? row.category,
            severity: input.severity ?? row.severity,
            status,
            closedOn,
          },
          ...requestMeta(request),
        });
      });

      const { rows } = await getPool().query<CaseRow>(
        `${caseSelect} WHERE c.school_id = $1 AND c.id = $2`,
        [schoolId, id],
      );
      return mapCase(rows[0]!);
    },
  );

  app.post(
    '/api/schools/:schoolId/safeguarding/:id/notes',
    { preHandler: requirePermission('safeguarding.case.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(safeguardingNoteInput, request.body);

      const created = await withTransaction(async (client) => {
        const existing = await client.query<{ status: SafeguardingCaseSummary['status'] }>(
          'SELECT status FROM safeguarding_cases WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        if (!existing.rows[0]) throw notFound('Safeguarding case not found');
        if (existing.rows[0].status === 'closed') {
          throw conflict('Reopen the case before adding notes', 'case_closed');
        }

        const { rows } = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO safeguarding_notes (school_id, case_id, note, author_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, created_at`,
          [schoolId, id, input.note, actor.userId],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'safeguarding.note_added',
          entityType: 'safeguarding_case',
          entityId: id,
          outcome: 'success',
          after: { noteId: rows[0]!.id },
          ...requestMeta(request),
        });
        return rows[0]!;
      });

      return reply.status(201).send({
        id: created.id,
        note: input.note,
        authorName: actor.displayName ?? null,
        createdAt: toIsoDateTime(created.created_at),
      });
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

interface CaseRow {
  id: string;
  student_id: string;
  first_name: string;
  last_name: string | null;
  admission_number: string;
  reference: string;
  category: SafeguardingCaseSummary['category'];
  severity: SafeguardingCaseSummary['severity'];
  summary: string;
  status: SafeguardingCaseSummary['status'];
  opened_on: string;
  closed_on: string | null;
  opened_by_name: string | null;
  note_count: string;
  created_at: Date;
  updated_at: Date;
}

const caseSelect = `
  SELECT c.id, c.student_id, st.first_name, st.last_name, st.admission_number,
         c.reference, c.category, c.severity, c.summary, c.status,
         c.opened_on, c.closed_on, u.display_name AS opened_by_name,
         (SELECT count(*) FROM safeguarding_notes n
          WHERE n.school_id = c.school_id AND n.case_id = c.id)::text AS note_count,
         c.created_at, c.updated_at
  FROM safeguarding_cases c
  JOIN students st ON st.id = c.student_id AND st.school_id = c.school_id
  LEFT JOIN users u ON u.id = c.opened_by`;

function mapCase(row: CaseRow): SafeguardingCaseSummary {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: fullName(row.first_name, null, row.last_name),
    admissionNumber: row.admission_number,
    reference: row.reference,
    category: row.category,
    severity: row.severity,
    summary: row.summary,
    status: row.status,
    openedOn: toIsoDate(row.opened_on),
    closedOn: row.closed_on ? toIsoDate(row.closed_on) : null,
    openedByName: row.opened_by_name,
    noteCount: Number(row.note_count),
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

async function nextReference(client: pg.PoolClient, schoolId: string): Promise<string> {
  const { rows } = await client.query<{ value: number }>(
    `INSERT INTO school_counters (school_id, name, value)
     VALUES ($1, 'safeguarding_case', 1)
     ON CONFLICT (school_id, name)
     DO UPDATE SET value = school_counters.value + 1
     RETURNING value`,
    [schoolId],
  );
  return `SG-${String(rows[0]!.value).padStart(4, '0')}`;
}
