import {
  importPreviewInput,
  savedReportInput,
  savedReportUpdate,
  uuid,
  type ImportBatch,
  type ImportRow,
  type SavedReport,
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
const listQuery = z.object({
  reportType: z.enum(['students', 'attendance', 'fees']).optional(),
});
const importQuery = z.object({
  entityType: z.enum(['students', 'library_books', 'vendors']).optional(),
  status: z.enum(['previewed', 'committed', 'cancelled']).optional(),
});

const ALLOWED_FILTERS: Record<SavedReport['reportType'], string[]> = {
  students: ['academicYearId', 'sectionId'],
  attendance: ['from', 'to', 'academicYearId', 'sectionId'],
  fees: ['academicYearId', 'sectionId'],
};

/**
 * Saved report views and two-step CSV imports.
 *
 * A saved view stores only its name, type and filters; results are recomputed by
 * the report endpoints when opened. Imports are always previewed first and every
 * row keeps its validation result. Commit applies only valid rows inside one
 * transaction and refuses a batch that was already committed, so retrying after
 * a dropped connection cannot duplicate records.
 */
export async function registerSavedReportRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ saved reports ---------------------------- */

  app.get(
    '/api/schools/:schoolId/saved-reports',
    { preHandler: requirePermission('reports.saved.manage') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(listQuery, request.query);
      const actor = getActor(request);
      const params: unknown[] = [schoolId, actor.userId];
      let filter = '';
      if (query.reportType) {
        params.push(query.reportType);
        filter = `AND r.report_type = $${params.length}`;
      }
      const { rows } = await getPool().query<{
        id: string;
        name: string;
        report_type: SavedReport['reportType'];
        filters: Record<string, string | undefined>;
        shared: boolean;
        created_by_name: string | null;
        created_at: Date;
      }>(
        `SELECT r.id, r.name, r.report_type, r.filters, r.shared,
                u.display_name AS created_by_name, r.created_at
         FROM saved_reports r
         LEFT JOIN users u ON u.id = r.created_by
         WHERE r.school_id = $1 AND (r.created_by = $2 OR r.shared = TRUE) ${filter}
         ORDER BY r.name`,
        params,
      );
      const items: SavedReport[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        reportType: row.report_type,
        filters: row.filters ?? {},
        shared: row.shared,
        createdByName: row.created_by_name,
        createdAt: toIsoDateTime(row.created_at),
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/saved-reports',
    { preHandler: requirePermission('reports.saved.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(savedReportInput, request.body);
      const actor = getActor(request);
      validateFilters(input.reportType, input.filters);
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO saved_reports (school_id, name, report_type, filters, shared, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          schoolId,
          input.name,
          input.reportType,
          JSON.stringify(input.filters),
          input.shared,
          actor.userId,
        ],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'reports.saved_view_created',
        entityType: 'saved_report',
        entityId: rows[0]!.id,
        outcome: 'success',
        after: { name: input.name, reportType: input.reportType, shared: input.shared },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  app.patch(
    '/api/schools/:schoolId/saved-reports/:id',
    { preHandler: requirePermission('reports.saved.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(savedReportUpdate, request.body);
      const actor = getActor(request);
      const { rows } = await getPool().query<{
        name: string;
        report_type: SavedReport['reportType'];
        filters: Record<string, string | undefined>;
        shared: boolean;
        created_by: string;
      }>(
        `SELECT name, report_type, filters, shared, created_by FROM saved_reports
         WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      );
      const row = rows[0];
      if (!row || row.created_by !== actor.userId) throw notFound('Saved report not found');
      const reportType = input.reportType ?? row.report_type;
      const filters = input.filters ?? row.filters ?? {};
      validateFilters(reportType, filters);
      await getPool().query(
        `UPDATE saved_reports SET name = $3, report_type = $4, filters = $5, shared = $6
         WHERE school_id = $1 AND id = $2`,
        [
          schoolId,
          id,
          input.name ?? row.name,
          reportType,
          JSON.stringify(filters),
          input.shared ?? row.shared,
        ],
      );
      return { id };
    },
  );

  app.delete(
    '/api/schools/:schoolId/saved-reports/:id',
    { preHandler: requirePermission('reports.saved.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const { rowCount } = await getPool().query(
        'DELETE FROM saved_reports WHERE school_id = $1 AND id = $2 AND created_by = $3',
        [schoolId, id, actor.userId],
      );
      if (rowCount === 0) throw notFound('Saved report not found');
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'reports.saved_view_deleted',
        entityType: 'saved_report',
        entityId: id,
        outcome: 'success',
        ...requestMeta(request),
      });
      return reply.status(204).send();
    },
  );

  /* --------------------------------- imports ------------------------------- */

  app.get(
    '/api/schools/:schoolId/imports',
    { preHandler: requirePermission('imports.manage') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(importQuery, request.query);
      const params: unknown[] = [schoolId];
      const filters = ['school_id = $1'];
      if (query.entityType) {
        params.push(query.entityType);
        filters.push(`entity_type = $${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        filters.push(`status = $${params.length}`);
      }
      const { rows } = await getPool().query<BatchRow>(
        `${batchSelect} WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT 100`,
        params,
      );
      return { items: rows.map(toBatch) };
    },
  );

  app.get(
    '/api/schools/:schoolId/imports/:id',
    { preHandler: requirePermission('imports.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const { rows } = await getPool().query<BatchRow>(
        `${batchSelect} WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      );
      if (!rows[0]) throw notFound('Import batch not found');
      const rowData = await getPool().query<RowRow>(
        `SELECT id, row_number, payload, errors, action, created_entity_id
         FROM import_batch_rows WHERE school_id = $1 AND batch_id = $2 ORDER BY row_number`,
        [schoolId, id],
      );
      return { ...toBatch(rows[0]), rows: rowData.rows.map(toRow) };
    },
  );

  app.post(
    '/api/schools/:schoolId/imports/preview',
    { preHandler: requirePermission('imports.manage') },
    idempotentRoute('POST /imports/preview', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(importPreviewInput, request.body);
      const actor = getActor(request);

      let parsed: string[][];
      try {
        parsed = parseCsv(input.csv);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : 'The CSV could not be read');
      }
      if (parsed.length < 2) {
        throw badRequest('The CSV needs a header row and at least one data row');
      }
      const header = parsed[0]!.map((cell) => cell.trim().toLowerCase());
      const body = parsed
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''));
      if (body.length === 0) throw badRequest('The CSV has no data rows');
      if (body.length > 500) throw badRequest('Import at most 500 rows in one file');

      const prepared = await prepareImport(schoolId, input.entityType, header, body);

      const created = await withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO import_batches
             (school_id, entity_type, filename, total_rows, valid_rows, invalid_rows, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            schoolId,
            input.entityType,
            input.filename,
            prepared.length,
            prepared.filter((row) => row.errors.length === 0).length,
            prepared.filter((row) => row.errors.length > 0).length,
            actor.userId,
          ],
        );
        const batchId = rows[0]!.id;
        for (const row of prepared) {
          await client.query(
            `INSERT INTO import_batch_rows
               (school_id, batch_id, row_number, payload, errors, action)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              schoolId,
              batchId,
              row.rowNumber,
              JSON.stringify(row.payload),
              JSON.stringify(row.errors),
              row.errors.length === 0 ? 'create' : 'skip',
            ],
          );
        }
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'imports.previewed',
          entityType: 'import_batch',
          entityId: batchId,
          outcome: 'success',
          after: {
            entityType: input.entityType,
            totalRows: prepared.length,
            validRows: prepared.filter((row) => row.errors.length === 0).length,
          },
          ...requestMeta(request),
        });
        return batchId;
      });

      return reply.status(201).send({
        id: created,
        totalRows: prepared.length,
        validRows: prepared.filter((row) => row.errors.length === 0).length,
        invalidRows: prepared.filter((row) => row.errors.length > 0).length,
      });
    }),
  );

  app.post(
    '/api/schools/:schoolId/imports/:id/commit',
    { preHandler: requirePermission('imports.manage') },
    idempotentRoute('POST /imports/commit', async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const committed = await withTransaction(async (client) => {
        const found = await client.query<{
          entity_type: ImportBatch['entityType'];
          status: ImportBatch['status'];
          valid_rows: number;
        }>(
          `SELECT entity_type, status, valid_rows FROM import_batches
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const batch = found.rows[0];
        if (!batch) throw notFound('Import batch not found');
        if (batch.status === 'committed') throw conflict('This import was already committed');
        if (batch.status === 'cancelled') throw conflict('This import was cancelled');

        const rows = await client.query<RowRow>(
          `SELECT id, row_number, payload, errors, action, created_entity_id
           FROM import_batch_rows
           WHERE school_id = $1 AND batch_id = $2 AND action = 'create'
           ORDER BY row_number`,
          [schoolId, id],
        );
        if (rows.rows.length !== batch.valid_rows) {
          throw conflict('The import rows no longer match the preview; create a new preview');
        }

        let created = 0;
        for (const row of rows.rows) {
          let entityId: string;
          try {
            entityId = await commitRow(client, schoolId, batch.entity_type, row.payload, actor.userId);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'This row could not be imported';
            throw conflict(`Row ${row.row_number}: ${message}`, 'import_row_failed');
          }
          await client.query(
            `UPDATE import_batch_rows SET created_entity_id = $4
             WHERE school_id = $1 AND batch_id = $2 AND id = $3`,
            [schoolId, id, row.id, entityId],
          );
          created += 1;
        }

        await client.query(
          `UPDATE import_batches SET
             status = 'committed', created_rows = $3, committed_by = $4, committed_at = now()
           WHERE school_id = $1 AND id = $2`,
          [schoolId, id, created, actor.userId],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'imports.committed',
          entityType: 'import_batch',
          entityId: id,
          outcome: 'success',
          after: { entityType: batch.entity_type, created },
          ...requestMeta(request),
        });
        return { id, created, status: 'committed' };
      });
      return committed;
    }),
  );

  app.post(
    '/api/schools/:schoolId/imports/:id/cancel',
    { preHandler: requirePermission('imports.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const { rows } = await getPool().query<{ id: string }>(
        `UPDATE import_batches SET status = 'cancelled'
         WHERE school_id = $1 AND id = $2 AND status = 'previewed' RETURNING id`,
        [schoolId, id],
      );
      if (!rows[0]) throw conflict('Only a previewed import can be cancelled');
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'imports.cancelled',
        entityType: 'import_batch',
        entityId: id,
        outcome: 'success',
        ...requestMeta(request),
      });
      return { id, status: 'cancelled' };
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

interface BatchRow {
  id: string;
  entity_type: ImportBatch['entityType'];
  filename: string;
  status: ImportBatch['status'];
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  created_rows: number;
  created_at: Date;
  committed_at: Date | null;
}

interface RowRow {
  id: string;
  row_number: number;
  payload: Record<string, string>;
  errors: string[];
  action: ImportRow['action'];
  created_entity_id: string | null;
}

const batchSelect = `
  SELECT id, entity_type, filename, status, total_rows, valid_rows, invalid_rows,
         created_rows, created_at, committed_at
  FROM import_batches`;

function toBatch(row: BatchRow): ImportBatch {
  return {
    id: row.id,
    entityType: row.entity_type,
    filename: row.filename,
    status: row.status,
    totalRows: row.total_rows,
    validRows: row.valid_rows,
    invalidRows: row.invalid_rows,
    createdRows: row.created_rows,
    createdAt: toIsoDateTime(row.created_at),
    committedAt: row.committed_at ? toIsoDateTime(row.committed_at) : null,
  };
}

function toRow(row: RowRow): ImportRow {
  return {
    id: row.id,
    rowNumber: row.row_number,
    payload: row.payload ?? {},
    errors: row.errors ?? [],
    action: row.action,
    createdEntityId: row.created_entity_id,
  };
}

function validateFilters(
  reportType: SavedReport['reportType'],
  filters: Record<string, string | undefined>,
): void {
  const allowed = ALLOWED_FILTERS[reportType];
  const unknown = Object.keys(filters).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw badRequest(`These filters are not valid for a ${reportType} report`, {
      filters: [`Remove: ${unknown.join(', ')}`],
    });
  }
}

interface PreparedRow {
  rowNumber: number;
  payload: Record<string, string>;
  errors: string[];
}

async function prepareImport(
  schoolId: string,
  entityType: ImportBatch['entityType'],
  header: string[],
  body: string[][],
): Promise<PreparedRow[]> {
  const requireColumn = (name: string) => {
    if (!header.includes(name)) throw badRequest(`The CSV needs a "${name}" column`);
  };

  if (entityType === 'students') {
    requireColumn('first_name');
    requireColumn('class_name');
    requireColumn('section_name');
    const year = await getPool().query<{ id: string }>(
      `SELECT id FROM academic_years WHERE school_id = $1 AND is_active = TRUE`,
      [schoolId],
    );
    if (!year.rows[0]) {
      throw badRequest('Set an active academic year before importing students');
    }
  } else if (entityType === 'library_books') {
    requireColumn('title');
  } else {
    requireColumn('name');
  }

  const prepared: PreparedRow[] = [];
  for (const [index, raw] of body.entries()) {
    const payload: Record<string, string> = {};
    header.forEach((key, column) => {
      payload[key] = (raw[column] ?? '').trim();
    });
    const errors: string[] = [];
    const value = (name: string) => payload[name] ?? '';

    if (entityType === 'students') {
      if (!value('first_name')) errors.push('first_name is required');
      if (!value('class_name')) errors.push('class_name is required');
      if (!value('section_name')) errors.push('section_name is required');
      if (value('date_of_birth') && !/^\d{4}-\d{2}-\d{2}$/.test(value('date_of_birth'))) {
        errors.push('date_of_birth must be YYYY-MM-DD');
      }
      if (value('class_name') && value('section_name')) {
        const section = await getPool().query(
          `SELECT 1 FROM sections sec
           JOIN classes c ON c.id = sec.class_id AND c.school_id = sec.school_id
           JOIN academic_years y ON y.id = sec.academic_year_id AND y.school_id = sec.school_id
           WHERE sec.school_id = $1 AND y.is_active = TRUE
             AND lower(c.name) = lower($2) AND lower(sec.name) = lower($3)`,
          [schoolId, value('class_name'), value('section_name')],
        );
        if (section.rowCount === 0) {
          errors.push(`No section "${value('section_name')}" in class "${value('class_name')}"`);
        }
      }
      if (value('admission_number')) {
        const duplicate = await getPool().query(
          'SELECT 1 FROM students WHERE school_id = $1 AND lower(admission_number) = lower($2)',
          [schoolId, value('admission_number')],
        );
        if (duplicate.rowCount) errors.push('That admission number is already in use');
      }
    } else if (entityType === 'library_books') {
      if (!value('title')) errors.push('title is required');
      const copies = value('copies') || '0';
      if (!/^\d+$/.test(copies) || Number(copies) > 500) {
        errors.push('copies must be a whole number from 0 to 500');
      }
      if (value('category_code')) {
        const category = await getPool().query(
          'SELECT 1 FROM library_categories WHERE school_id = $1 AND lower(code) = lower($2)',
          [schoolId, value('category_code')],
        );
        if (category.rowCount === 0) errors.push('That category code was not found');
      }
    } else {
      if (!value('name')) errors.push('name is required');
      if (value('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value('email'))) {
        errors.push('email is not valid');
      }
      if (value('status') && !['active', 'inactive', 'blocked'].includes(value('status'))) {
        errors.push('status must be active, inactive or blocked');
      }
      if (value('code')) {
        const duplicate = await getPool().query(
          'SELECT 1 FROM vendors WHERE school_id = $1 AND lower(code) = lower($2)',
          [schoolId, value('code')],
        );
        if (duplicate.rowCount) errors.push('That vendor code is already in use');
      }
    }

    prepared.push({ rowNumber: index + 2, payload, errors });
  }
  return prepared;
}

async function commitRow(
  client: Pick<pg.PoolClient, 'query'>,
  schoolId: string,
  entityType: ImportBatch['entityType'],
  payload: Record<string, string>,
  actorUserId: string,
): Promise<string> {
  if (entityType === 'students') {
    const year = await client.query<{ id: string; starts_on: string }>(
      `SELECT id, starts_on FROM academic_years WHERE school_id = $1 AND is_active = TRUE`,
      [schoolId],
    );
    const activeYear = year.rows[0];
    if (!activeYear) throw badRequest('No active academic year');
    const section = await client.query<{ id: string; class_id: string; year_code: string }>(
      `SELECT sec.id, sec.class_id, y.code AS year_code
       FROM sections sec
       JOIN classes c ON c.id = sec.class_id AND c.school_id = sec.school_id
       JOIN academic_years y ON y.id = sec.academic_year_id AND y.school_id = sec.school_id
       WHERE sec.school_id = $1 AND sec.academic_year_id = $2
         AND lower(c.name) = lower($3) AND lower(sec.name) = lower($4)`,
      [schoolId, activeYear.id, payload.class_name, payload.section_name],
    );
    const sectionRow = section.rows[0];
    if (!sectionRow) throw badRequest('The section no longer exists');
    const admission =
      payload.admission_number || (await nextAdmissionNumber(client, schoolId, sectionRow.year_code));
    const student = await client.query<{ id: string }>(
      `INSERT INTO students
         (school_id, admission_number, first_name, middle_name, last_name, date_of_birth, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING id`,
      [
        schoolId,
        admission,
        payload.first_name,
        payload.middle_name || null,
        payload.last_name || null,
        payload.date_of_birth || null,
      ],
    );
    const studentId = student.rows[0]!.id;
    await client.query(
      `INSERT INTO enrollments
         (school_id, student_id, academic_year_id, class_id, section_id, enrollment_status,
          starts_on)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
      [
        schoolId,
        studentId,
        activeYear.id,
        sectionRow.class_id,
        sectionRow.id,
        toIsoDate(activeYear.starts_on) || new Date().toISOString().slice(0, 10),
      ],
    );
    return studentId;
  }

  if (entityType === 'library_books') {
    const categoryId = payload.category_code
      ? (
          await client.query<{ id: string }>(
            'SELECT id FROM library_categories WHERE school_id = $1 AND lower(code) = lower($2)',
            [schoolId, payload.category_code],
          )
        ).rows[0]?.id ?? null
      : null;
    const book = await client.query<{ id: string }>(
      `INSERT INTO library_books
         (school_id, category_id, title, author, publisher, isbn, language, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        schoolId,
        categoryId,
        payload.title,
        payload.author || null,
        payload.publisher || null,
        payload.isbn || null,
        payload.language || null,
        payload.description || null,
      ],
    );
    const bookId = book.rows[0]!.id;
    const copies = Number(payload.copies || '0');
    for (let index = 0; index < copies; index += 1) {
      await client.query(
        `INSERT INTO library_copies (school_id, book_id, accession_number)
         VALUES ($1, $2, $3)`,
        [schoolId, bookId, await nextAccession(client, schoolId)],
      );
    }
    return bookId;
  }

  const code = payload.code || (await nextVendorCode(client, schoolId));
  const vendor = await client.query<{ id: string }>(
    `INSERT INTO vendors
       (school_id, code, name, contact_name, email, phone, address, status, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      schoolId,
      code,
      payload.name,
      payload.contact_name || null,
      payload.email || null,
      payload.phone || null,
      payload.address || null,
      payload.status || 'active',
      payload.notes || null,
      actorUserId,
    ],
  );
  return vendor.rows[0]!.id;
}

async function nextAdmissionNumber(
  client: Pick<pg.PoolClient, 'query'>,
  schoolId: string,
  yearCode: string,
): Promise<string> {
  const { rows } = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM students WHERE school_id = $1',
    [schoolId],
  );
  return `${yearCode}-${String(toNumber(rows[0]?.count) + 1).padStart(4, '0')}`;
}

async function nextAccession(
  client: Pick<pg.PoolClient, 'query'>,
  schoolId: string,
): Promise<string> {
  const { rows } = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM library_copies WHERE school_id = $1',
    [schoolId],
  );
  return `ACC-${String(toNumber(rows[0]?.count) + 1).padStart(6, '0')}`;
}

async function nextVendorCode(
  client: Pick<pg.PoolClient, 'query'>,
  schoolId: string,
): Promise<string> {
  const { rows } = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM vendors WHERE school_id = $1',
    [schoolId],
  );
  return `VEN-${String(toNumber(rows[0]?.count) + 1).padStart(4, '0')}`;
}

/**
 * Minimal RFC 4180 reader: quoted cells, escaped quotes and CRLF are supported.
 * It rejects unbalanced quotes instead of silently guessing.
 */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const input = csv.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      if (cell !== '') throw badRequest('A quote can only start a quoted CSV cell');
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char === '\r') {
      // Ignored; the following \n ends the row.
    } else {
      cell += char;
    }
  }
  if (quoted) throw badRequest('The CSV has an unclosed quote');
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
