import { visibleSectionIds } from '@erp/core';
import {
  academicYearInput,
  academicYearUpdate,
  classInput,
  classUpdate,
  sectionInput,
  sectionUpdate,
  subjectInput,
  subjectUpdate,
  uuid,
  type AcademicYear,
  type ClassRecord,
  type SectionRecord,
  type SubjectRecord,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAnyPermission, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { badRequest, conflict, notFound, parseInput } from '../lib/errors';
import { assertDateRange, toIsoDate, toNumber } from '../lib/format';
import { recordActivity, recordAudit } from '../lib/audit';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });

export async function registerAcademicRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ academic years --------------------------- */

  app.get(
    '/api/schools/:schoolId/academic-years',
    { preHandler: requireAnyPermission('academic.structure.view', 'school.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query(
        `SELECT id, code, name, starts_on, ends_on, status
         FROM academic_years WHERE school_id = $1 ORDER BY starts_on DESC`,
        [schoolId],
      );
      return { items: rows.map(mapAcademicYear) };
    },
  );

  app.post(
    '/api/schools/:schoolId/academic-years',
    { preHandler: requirePermission('academic.year.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(academicYearInput, request.body);
      assertDateRange(input.startsOn, input.endsOn);

      const year = await withTransaction(async (client) => {
        if (input.status === 'active') {
          await client.query(
            `UPDATE academic_years SET status = 'closed'
             WHERE school_id = $1 AND status = 'active'`,
            [schoolId],
          );
        }
        const { rows } = await client.query<AcademicYearRow>(
          `INSERT INTO academic_years (school_id, code, name, starts_on, ends_on, status)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, code, name, starts_on, ends_on, status`,
          [schoolId, input.code, input.name, input.startsOn, input.endsOn, input.status],
        );
        const created = rows[0]!;
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'academic_year.created',
          entityType: 'academic_year',
          entityId: created.id,
          outcome: 'success',
          after: created,
          ...requestMeta(request),
        });
        await recordActivity(client, {
          schoolId,
          entityType: 'academic_year',
          entityId: created.id,
          eventType: 'academic_year.created',
          actorUserId: actor.userId,
          summary: `Academic year ${created.name} created`,
        });
        return created;
      });

      return reply.status(201).send(mapAcademicYear(year));
    },
  );

  app.patch(
    '/api/schools/:schoolId/academic-years/:id',
    { preHandler: requirePermission('academic.year.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(academicYearUpdate, request.body);

      const year = await withTransaction(async (client) => {
        const { rows: existingRows } = await client.query<AcademicYearRow>(
          `SELECT id, code, name, starts_on, ends_on, status
           FROM academic_years WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const existing = existingRows[0];
        if (!existing) throw notFound('Academic year not found');

        const next = {
          name: input.name ?? existing.name,
          startsOn: input.startsOn ?? toIsoDate(existing.starts_on),
          endsOn: input.endsOn ?? toIsoDate(existing.ends_on),
          status: input.status ?? existing.status,
        };
        assertDateRange(next.startsOn, next.endsOn);
        if (existing.status === 'archived' && next.status !== 'archived') {
          throw conflict('An archived academic year cannot be reopened', 'invalid_state');
        }
        if (next.status === 'active' && existing.status !== 'active') {
          await client.query(
            `UPDATE academic_years SET status = 'closed'
             WHERE school_id = $1 AND status = 'active' AND id <> $2`,
            [schoolId, id],
          );
        }

        const { rows } = await client.query<AcademicYearRow>(
          `UPDATE academic_years
           SET name = $3, starts_on = $4, ends_on = $5, status = $6
           WHERE school_id = $1 AND id = $2
           RETURNING id, code, name, starts_on, ends_on, status`,
          [schoolId, id, next.name, next.startsOn, next.endsOn, next.status],
        );
        const updated = rows[0]!;
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'academic_year.updated',
          entityType: 'academic_year',
          entityId: id,
          outcome: 'success',
          before: existing,
          after: updated,
          ...requestMeta(request),
        });
        return updated;
      });

      return mapAcademicYear(year);
    },
  );

  app.post(
    '/api/schools/:schoolId/academic-years/:id/activate',
    { preHandler: requirePermission('academic.year.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);

      const year = await withTransaction(async (client) => {
        const { rows: existingRows } = await client.query<AcademicYearRow>(
          `SELECT id, code, name, starts_on, ends_on, status
           FROM academic_years WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const existing = existingRows[0];
        if (!existing) throw notFound('Academic year not found');
        if (existing.status === 'archived') {
          throw conflict('An archived academic year cannot be activated', 'invalid_state');
        }

        if (existing.status !== 'active') {
          await client.query(
            `UPDATE academic_years SET status = 'closed'
             WHERE school_id = $1 AND status = 'active'`,
            [schoolId],
          );
          await client.query('UPDATE academic_years SET status = $3 WHERE id = $2 AND school_id = $1', [
            schoolId,
            id,
            'active',
          ]);
        }

        const { rows } = await client.query<AcademicYearRow>(
          `SELECT id, code, name, starts_on, ends_on, status FROM academic_years
           WHERE school_id = $1 AND id = $2`,
          [schoolId, id],
        );
        const updated = rows[0]!;
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'academic_year.activated',
          entityType: 'academic_year',
          entityId: id,
          outcome: 'success',
          before: existing,
          after: updated,
          ...requestMeta(request),
        });
        await recordActivity(client, {
          schoolId,
          entityType: 'academic_year',
          entityId: id,
          eventType: 'academic_year.activated',
          actorUserId: actor.userId,
          summary: `${updated.name} is now the active academic year`,
        });
        return updated;
      });

      return mapAcademicYear(year);
    },
  );

  /* --------------------------------- classes ------------------------------- */

  app.get(
    '/api/schools/:schoolId/classes',
    { preHandler: requireAnyPermission('academic.structure.view', 'school.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query(
        `SELECT id, code, name, grade_order, status FROM classes
         WHERE school_id = $1 ORDER BY grade_order NULLS LAST, name`,
        [schoolId],
      );
      return { items: rows.map(mapClass) };
    },
  );

  app.post(
    '/api/schools/:schoolId/classes',
    { preHandler: requirePermission('academic.class.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(classInput, request.body);

      const created = await withTransaction(async (client) => {
        const { rows } = await client.query<ClassRow>(
          `INSERT INTO classes (school_id, code, name, grade_order, status)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, code, name, grade_order, status`,
          [schoolId, input.code, input.name, input.gradeOrder ?? null, input.status],
        );
        const row = rows[0]!;
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'class.created',
          entityType: 'class',
          entityId: row.id,
          outcome: 'success',
          after: row,
          ...requestMeta(request),
        });
        return row;
      });

      return reply.status(201).send(mapClass(created));
    },
  );

  app.patch(
    '/api/schools/:schoolId/classes/:id',
    { preHandler: requirePermission('academic.class.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(classUpdate, request.body);

      const updated = await withTransaction(async (client) => {
        const { rows: existingRows } = await client.query<ClassRow>(
          `SELECT id, code, name, grade_order, status FROM classes
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const existing = existingRows[0];
        if (!existing) throw notFound('Class not found');

        const { rows } = await client.query<ClassRow>(
          `UPDATE classes SET code = $3, name = $4, grade_order = $5, status = $6
           WHERE school_id = $1 AND id = $2
           RETURNING id, code, name, grade_order, status`,
          [
            schoolId,
            id,
            input.code ?? existing.code,
            input.name ?? existing.name,
            input.gradeOrder === undefined ? existing.grade_order : input.gradeOrder,
            input.status ?? existing.status,
          ],
        );
        const row = rows[0]!;
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'class.updated',
          entityType: 'class',
          entityId: id,
          outcome: 'success',
          before: existing,
          after: row,
          ...requestMeta(request),
        });
        return row;
      });

      return mapClass(updated);
    },
  );

  /* -------------------------------- sections ------------------------------- */

  const sectionQuery = z.object({
    academicYearId: uuid.optional(),
    classId: uuid.optional(),
    status: z.enum(['active', 'inactive']).optional(),
  });

  app.get(
    '/api/schools/:schoolId/sections',
    { preHandler: requireAnyPermission('academic.structure.view', 'school.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(sectionQuery, request.query);
      const actor = getActor(request);

      const conditions = ['sec.school_id = $1'];
      const params: unknown[] = [schoolId];
      if (query.academicYearId) {
        params.push(query.academicYearId);
        conditions.push(`sec.academic_year_id = $${params.length}`);
      }
      if (query.classId) {
        params.push(query.classId);
        conditions.push(`sec.class_id = $${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        conditions.push(`sec.status = $${params.length}`);
      }
      const restricted = visibleSectionIds(actor);
      if (restricted) {
        params.push(restricted);
        conditions.push(`sec.id = ANY($${params.length}::uuid[])`);
      }

      const { rows } = await getPool().query<SectionRow>(
        `SELECT sec.id, sec.academic_year_id, sec.class_id, sec.code, sec.name,
                sec.capacity, sec.status,
                ay.name AS academic_year_name, c.name AS class_name,
                (SELECT count(*) FROM enrollments e
                  WHERE e.section_id = sec.id AND e.enrollment_status = 'active') AS enrolled
         FROM sections sec
         JOIN academic_years ay ON ay.id = sec.academic_year_id
         JOIN classes c ON c.id = sec.class_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY ay.starts_on DESC, c.grade_order NULLS LAST, sec.code`,
        params,
      );
      return { items: rows.map(mapSection) };
    },
  );

  app.post(
    '/api/schools/:schoolId/sections',
    { preHandler: requirePermission('academic.section.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(sectionInput, request.body);

      const created = await withTransaction(async (client) => {
        // Ensure both references belong to this school before inserting, so the
        // error message is precise instead of a generic FK failure.
        const refs = await client.query<{ year_ok: boolean; class_ok: boolean }>(
          `SELECT
             EXISTS (SELECT 1 FROM academic_years WHERE school_id = $1 AND id = $2) AS year_ok,
             EXISTS (SELECT 1 FROM classes WHERE school_id = $1 AND id = $3) AS class_ok`,
          [schoolId, input.academicYearId, input.classId],
        );
        if (!refs.rows[0]?.year_ok) throw badRequest('Academic year not found in this school');
        if (!refs.rows[0]?.class_ok) throw badRequest('Class not found in this school');

        const { rows } = await client.query<SectionRow>(
          `INSERT INTO sections
             (school_id, academic_year_id, class_id, code, name, capacity, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, academic_year_id, class_id, code, name, capacity, status,
                     (SELECT name FROM academic_years WHERE id = $2) AS academic_year_name,
                     (SELECT name FROM classes WHERE id = $3) AS class_name,
                     0 AS enrolled`,
          [
            schoolId,
            input.academicYearId,
            input.classId,
            input.code,
            input.name,
            input.capacity ?? null,
            input.status,
          ],
        );
        const row = rows[0]!;
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'section.created',
          entityType: 'section',
          entityId: row.id,
          outcome: 'success',
          after: row,
          ...requestMeta(request),
        });
        return row;
      });

      return reply.status(201).send(mapSection(created));
    },
  );

  app.patch(
    '/api/schools/:schoolId/sections/:id',
    { preHandler: requirePermission('academic.section.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(sectionUpdate, request.body);

      const updated = await withTransaction(async (client) => {
        const { rows: existingRows } = await client.query<SectionRow>(
          `SELECT sec.id, sec.academic_year_id, sec.class_id, sec.code, sec.name,
                  sec.capacity, sec.status,
                  ay.name AS academic_year_name, c.name AS class_name, 0 AS enrolled
           FROM sections sec
           JOIN academic_years ay ON ay.id = sec.academic_year_id
           JOIN classes c ON c.id = sec.class_id
           WHERE sec.school_id = $1 AND sec.id = $2 FOR UPDATE OF sec`,
          [schoolId, id],
        );
        const existing = existingRows[0];
        if (!existing) throw notFound('Section not found');

        const { rows } = await client.query<SectionRow>(
          `UPDATE sections
           SET code = $3, name = $4, capacity = $5, status = $6
           WHERE school_id = $1 AND id = $2
           RETURNING id, academic_year_id, class_id, code, name, capacity, status,
                     (SELECT name FROM academic_years WHERE id = academic_year_id) AS academic_year_name,
                     (SELECT name FROM classes WHERE id = class_id) AS class_name,
                     (SELECT count(*) FROM enrollments e
                       WHERE e.section_id = sections.id AND e.enrollment_status = 'active') AS enrolled`,
          [
            schoolId,
            id,
            input.code ?? existing.code,
            input.name ?? existing.name,
            input.capacity === undefined ? existing.capacity : input.capacity,
            input.status ?? existing.status,
          ],
        );
        const row = rows[0]!;
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'section.updated',
          entityType: 'section',
          entityId: id,
          outcome: 'success',
          before: existing,
          after: row,
          ...requestMeta(request),
        });
        return row;
      });

      return mapSection(updated);
    },
  );

  /* -------------------------------- subjects ------------------------------- */

  app.get(
    '/api/schools/:schoolId/subjects',
    { preHandler: requireAnyPermission('academic.structure.view', 'school.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query(
        `SELECT id, code, name, subject_type, status FROM subjects
         WHERE school_id = $1 ORDER BY name`,
        [schoolId],
      );
      return { items: rows.map(mapSubject) };
    },
  );

  app.post(
    '/api/schools/:schoolId/subjects',
    { preHandler: requirePermission('academic.subject.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(subjectInput, request.body);

      const created = await withTransaction(async (client) => {
        const { rows } = await client.query<SubjectRow>(
          `INSERT INTO subjects (school_id, code, name, subject_type, status)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, code, name, subject_type, status`,
          [schoolId, input.code, input.name, input.subjectType, input.status],
        );
        const row = rows[0]!;
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'subject.created',
          entityType: 'subject',
          entityId: row.id,
          outcome: 'success',
          after: row,
          ...requestMeta(request),
        });
        return row;
      });

      return reply.status(201).send(mapSubject(created));
    },
  );

  app.patch(
    '/api/schools/:schoolId/subjects/:id',
    { preHandler: requirePermission('academic.subject.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(subjectUpdate, request.body);

      const updated = await withTransaction(async (client) => {
        const { rows: existingRows } = await client.query<SubjectRow>(
          `SELECT id, code, name, subject_type, status FROM subjects
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const existing = existingRows[0];
        if (!existing) throw notFound('Subject not found');

        const { rows } = await client.query<SubjectRow>(
          `UPDATE subjects SET code = $3, name = $4, subject_type = $5, status = $6
           WHERE school_id = $1 AND id = $2
           RETURNING id, code, name, subject_type, status`,
          [
            schoolId,
            id,
            input.code ?? existing.code,
            input.name ?? existing.name,
            input.subjectType ?? existing.subject_type,
            input.status ?? existing.status,
          ],
        );
        const row = rows[0]!;
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'subject.updated',
          entityType: 'subject',
          entityId: id,
          outcome: 'success',
          before: existing,
          after: row,
          ...requestMeta(request),
        });
        return row;
      });

      return mapSubject(updated);
    },
  );
}

interface AcademicYearRow {
  id: string;
  code: string;
  name: string;
  starts_on: string;
  ends_on: string;
  status: AcademicYear['status'];
}

interface ClassRow {
  id: string;
  code: string;
  name: string;
  grade_order: number | null;
  status: ClassRecord['status'];
}

interface SectionRow {
  id: string;
  academic_year_id: string;
  class_id: string;
  code: string;
  name: string;
  capacity: number | null;
  status: SectionRecord['status'];
  academic_year_name: string;
  class_name: string;
  enrolled: string | number;
}

interface SubjectRow {
  id: string;
  code: string;
  name: string;
  subject_type: string;
  status: SubjectRecord['status'];
}

function mapAcademicYear(row: AcademicYearRow): AcademicYear {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    startsOn: toIsoDate(row.starts_on),
    endsOn: toIsoDate(row.ends_on),
    status: row.status,
  };
}

function mapClass(row: ClassRow): ClassRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    gradeOrder: row.grade_order,
    status: row.status,
  };
}

function mapSection(row: SectionRow): SectionRecord {
  return {
    id: row.id,
    academicYearId: row.academic_year_id,
    academicYearName: row.academic_year_name,
    classId: row.class_id,
    className: row.class_name,
    code: row.code,
    name: row.name,
    capacity: row.capacity,
    enrolled: toNumber(row.enrolled),
    status: row.status,
  };
}

function mapSubject(row: SubjectRow): SubjectRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    subjectType: row.subject_type,
    status: row.status,
  };
}
