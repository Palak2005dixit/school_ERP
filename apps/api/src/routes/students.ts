import { fullName, visibleSectionIds } from '@erp/core';
import {
  enrollmentInput,
  guardianInput,
  studentAdmissionInput,
  studentImportInput,
  studentListQuery,
  studentUpdate,
  uuid,
  type ChildSummary,
  type EnrollmentRecord,
  type GuardianRecord,
  type Paginated,
  type StudentDetail,
  type StudentImportResult,
  type StudentSummary,
} from '@erp/shared';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { badRequest, conflict, notFound, parseInput } from '../lib/errors';
import { pageMeta, toIsoDate, toIsoDateTime, toNumber } from '../lib/format';
import { recordActivity, recordAudit } from '../lib/audit';
import { idempotentRoute } from '../lib/idempotency';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const guardianParams = z.object({ schoolId: uuid, id: uuid });

export async function registerStudentRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------- listing -------------------------------- */

  app.get(
    '/api/schools/:schoolId/students',
    { preHandler: requirePermission('students.profile.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(studentListQuery, request.query);
      const actor = getActor(request);

      const conditions = ['st.school_id = $1'];
      const params: unknown[] = [schoolId];

      if (query.search) {
        params.push(`%${query.search}%`);
        conditions.push(
          `(st.admission_number ILIKE $${params.length}
            OR st.first_name ILIKE $${params.length}
            OR COALESCE(st.last_name, '') ILIKE $${params.length})`,
        );
      }
      if (query.status) {
        params.push(query.status);
        conditions.push(`st.status = $${params.length}`);
      }
      if (query.classId) {
        params.push(query.classId);
        conditions.push(`en.class_id = $${params.length}`);
      }
      if (query.sectionId) {
        params.push(query.sectionId);
        conditions.push(`en.section_id = $${params.length}`);
      }

      // Teachers only see students in sections they are assigned to. The filter
      // is applied server-side; a client-supplied sectionId cannot widen it.
      const restricted = visibleSectionIds(actor);
      if (restricted) {
        params.push(restricted);
        conditions.push(`en.section_id = ANY($${params.length}::uuid[])`);
      }

      const where = conditions.join(' AND ');
      const fromSql = `
        FROM students st
        LEFT JOIN LATERAL (
          SELECT e.class_id, e.section_id, e.academic_year_id
          FROM enrollments e
          WHERE e.student_id = st.id AND e.enrollment_status = 'active'
          ORDER BY e.starts_on DESC
          LIMIT 1
        ) en ON true
        LEFT JOIN classes c ON c.id = en.class_id
        LEFT JOIN sections sec ON sec.id = en.section_id
        LEFT JOIN academic_years ay ON ay.id = en.academic_year_id`;

      const countResult = await getPool().query<{ total: string }>(
        `SELECT count(*)::text AS total ${fromSql} WHERE ${where}`,
        params,
      );
      const total = toNumber(countResult.rows[0]?.total);

      const limit = query.pageSize;
      const offset = (query.page - 1) * query.pageSize;
      const listParams = [...params, limit, offset];

      const { rows } = await getPool().query<StudentSummaryRow>(
        `SELECT st.id, st.admission_number, st.first_name, st.last_name, st.status,
                c.name AS class_name, sec.name AS section_name, ay.name AS academic_year_name,
                (SELECT count(*) FROM student_guardians sg
                  WHERE sg.student_id = st.id AND sg.valid_to IS NULL) AS guardian_count
         ${fromSql}
         WHERE ${where}
         ORDER BY st.admission_number
         LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
        listParams,
      );

      const body: Paginated<StudentSummary> = {
        items: rows.map(mapStudentSummary),
        ...pageMeta(total, query.page, query.pageSize),
      };
      return body;
    },
  );

  /* -------------------------------- admission ------------------------------ */

  app.post(
    '/api/schools/:schoolId/students',
    { preHandler: requirePermission('students.admission.create') },
    idempotentRoute('POST /students', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(studentAdmissionInput, request.body);
      assertSinglePrimary(input.guardians.map((guardian) => guardian.isPrimary));

      const created = await withTransaction(async (client) => {
        const section = await loadSectionForAdmission(
          client,
          schoolId,
          input.sectionId,
          input.academicYearId,
        );

        const admissionNumber =
          input.admissionNumber ?? (await nextAdmissionNumber(client, schoolId, section.year_code));

        const studentResult = await client.query<{ id: string }>(
          `INSERT INTO students
             (school_id, admission_number, first_name, middle_name, last_name, date_of_birth, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')
           RETURNING id`,
          [
            schoolId,
            admissionNumber,
            input.firstName,
            input.middleName ?? null,
            input.lastName ?? null,
            input.dateOfBirth ?? null,
          ],
        );
        const studentId = studentResult.rows[0]!.id;

        await client.query(
          `INSERT INTO enrollments
             (school_id, student_id, academic_year_id, class_id, section_id, enrollment_status, starts_on)
           VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
          [schoolId, studentId, input.academicYearId, section.class_id, section.id, input.startsOn],
        );

        for (const guardian of input.guardians) {
          const guardianId = await upsertGuardian(client, schoolId, guardian);
          await client.query(
            `INSERT INTO student_guardians
               (school_id, student_id, guardian_id, relationship_type, is_primary, portal_access_status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              schoolId,
              studentId,
              guardianId,
              guardian.relationshipType,
              guardian.isPrimary,
              guardian.portalAccessStatus,
            ],
          );
        }

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'student.admitted',
          entityType: 'student',
          entityId: studentId,
          outcome: 'success',
          after: {
            admissionNumber,
            name: fullName(input.firstName, input.middleName, input.lastName),
            sectionId: input.sectionId,
            academicYearId: input.academicYearId,
          },
          ...requestMeta(request),
        });
        await recordActivity(client, {
          schoolId,
          entityType: 'student',
          entityId: studentId,
          eventType: 'student.admitted',
          actorUserId: actor.userId,
          summary: `${fullName(input.firstName, input.lastName)} admitted to ${section.class_name} ${section.name}`,
        });

        return loadStudentDetail(client, schoolId, studentId);
      });

      return reply.status(201).send(created);
    }),
  );

  /* ------------------------------ CSV import -------------------------------- */

  app.post(
    '/api/schools/:schoolId/students/import',
    { preHandler: requirePermission('students.admission.create') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(studentImportInput, request.body);

      const year = await getPool().query<{ id: string; starts_on: string }>(
        'SELECT id, starts_on FROM academic_years WHERE school_id = $1 AND id = $2',
        [schoolId, input.academicYearId],
      );
      if (!year.rows[0]) throw notFound('Academic year not found');

      let rows: string[][];
      try {
        rows = parseCsv(input.csv);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : 'The CSV file could not be read');
      }
      if (rows.length < 2) {
        throw badRequest('The CSV needs a header row and at least one student row');
      }
      const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
      const required = ['first_name', 'class_name', 'section_name'];
      const missing = required.filter((column) => !header.includes(column));
      if (missing.length > 0) {
        throw badRequest(`Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
      }
      const column = (name: string) => header.indexOf(name);
      const bodyRows = rows.slice(1).filter((row) => row.some((cell) => cell.trim() !== ''));
      if (bodyRows.length === 0) throw badRequest('The CSV has no student rows');
      if (bodyRows.length > 500) {
        throw badRequest('Import at most 500 students in one file');
      }

      const result: StudentImportResult = { created: 0, failed: 0, errors: [] };

      for (const [index, row] of bodyRows.entries()) {
        const line = index + 2;
        const value = (name: string): string => {
          const at = column(name);
          return at === -1 ? '' : (row[at] ?? '').trim();
        };
        const firstName = value('first_name');
        const middleName = value('middle_name');
        const lastName = value('last_name');
        const admissionNumber = value('admission_number');
        const dateOfBirth = value('date_of_birth');
        const className = value('class_name');
        const sectionName = value('section_name');

        if (!firstName) {
          result.failed += 1;
          result.errors.push({ row: line, message: 'first_name is required' });
          continue;
        }
        if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
          result.failed += 1;
          result.errors.push({ row: line, message: 'date_of_birth must be YYYY-MM-DD' });
          continue;
        }

        try {
          await withTransaction(async (client) => {
            const section = await client.query<{
              id: string;
              class_id: string;
              year_code: string;
            }>(
              `SELECT sec.id, sec.class_id, y.code AS year_code
               FROM sections sec
               JOIN classes c ON c.id = sec.class_id AND c.school_id = sec.school_id
               JOIN academic_years y ON y.id = sec.academic_year_id AND y.school_id = sec.school_id
               WHERE sec.school_id = $1 AND sec.academic_year_id = $2
                 AND lower(c.name) = lower($3) AND lower(sec.name) = lower($4)`,
              [schoolId, input.academicYearId, className, sectionName],
            );
            const sectionRow = section.rows[0];
            if (!sectionRow) {
              throw badRequest(
                `No section "${sectionName}" in class "${className}" for that academic year`,
              );
            }

            const finalNumber =
              admissionNumber ||
              (await nextAdmissionNumber(client, schoolId, sectionRow.year_code));

            const student = await client.query<{ id: string }>(
              `INSERT INTO students
                 (school_id, admission_number, first_name, middle_name, last_name, date_of_birth, status)
               VALUES ($1, $2, $3, $4, $5, $6, 'active')
               RETURNING id`,
              [
                schoolId,
                finalNumber,
                firstName,
                middleName || null,
                lastName || null,
                dateOfBirth || null,
              ],
            );
            const studentId = student.rows[0]!.id;
            await client.query(
              `INSERT INTO enrollments
                 (school_id, student_id, academic_year_id, class_id, section_id, enrollment_status, starts_on)
               VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
              [
                schoolId,
                studentId,
                input.academicYearId,
                sectionRow.class_id,
                sectionRow.id,
                toIsoDate(year.rows[0]!.starts_on) ?? new Date().toISOString().slice(0, 10),
              ],
            );
            await recordAudit(client, {
              schoolId,
              actorUserId: actor.userId,
              action: 'student.imported',
              entityType: 'student',
              entityId: studentId,
              outcome: 'success',
              after: {
                admissionNumber: finalNumber,
                name: fullName(firstName, middleName, lastName),
                sectionId: sectionRow.id,
                academicYearId: input.academicYearId,
                sourceRow: line,
              },
              ...requestMeta(request),
            });
          });
          result.created += 1;
        } catch (error) {
          result.failed += 1;
          result.errors.push({
            row: line,
            message: error instanceof Error ? error.message : 'This row could not be imported',
          });
        }
      }

      await withTransaction(async (client) => {
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'students.bulk_imported',
          entityType: 'student',
          entityId: input.academicYearId,
          outcome: result.created > 0 ? 'success' : 'failure',
          after: {
            academicYearId: input.academicYearId,
            created: result.created,
            failed: result.failed,
            rows: bodyRows.length,
          },
          ...requestMeta(request),
        });
      });

      return reply.status(200).send(result);
    },
  );

  /* --------------------------------- detail -------------------------------- */

  app.get(
    '/api/schools/:schoolId/students/:id',
    { preHandler: requirePermission('students.profile.view') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      return withTransaction(async (client) => {
        await assertStudentVisible(client, schoolId, id, actor.assignments);
        return loadStudentDetail(client, schoolId, id);
      });
    },
  );

  app.patch(
    '/api/schools/:schoolId/students/:id',
    { preHandler: requirePermission('students.profile.edit') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(studentUpdate, request.body);

      return withTransaction(async (client) => {
        const { rows: existingRows } = await client.query<{
          id: string;
          first_name: string;
          middle_name: string | null;
          last_name: string | null;
          date_of_birth: string | null;
          status: string;
        }>(
          `SELECT id, first_name, middle_name, last_name, date_of_birth, status
           FROM students WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const existing = existingRows[0];
        if (!existing) throw notFound('Student not found');

        await client.query(
          `UPDATE students
           SET first_name = $3, middle_name = $4, last_name = $5,
               date_of_birth = $6, status = $7
           WHERE school_id = $1 AND id = $2`,
          [
            schoolId,
            id,
            input.firstName ?? existing.first_name,
            input.middleName === undefined ? existing.middle_name : input.middleName,
            input.lastName === undefined ? existing.last_name : input.lastName,
            input.dateOfBirth === undefined ? existing.date_of_birth : input.dateOfBirth,
            input.status ?? existing.status,
          ],
        );

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'student.updated',
          entityType: 'student',
          entityId: id,
          outcome: 'success',
          before: existing,
          after: input,
          ...requestMeta(request),
        });
        await recordActivity(client, {
          schoolId,
          entityType: 'student',
          entityId: id,
          eventType: 'student.updated',
          actorUserId: actor.userId,
          summary: 'Student profile updated',
        });

        return loadStudentDetail(client, schoolId, id);
      });
    },
  );

  /* -------------------------------- guardians ------------------------------ */

  app.post(
    '/api/schools/:schoolId/students/:id/guardians',
    { preHandler: requirePermission('students.guardian.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(guardianParams, request.params);
      const actor = getActor(request);
      const input = parseInput(guardianInput, request.body);

      const guardian = await withTransaction(async (client) => {
        const student = await client.query<{ id: string }>(
          'SELECT id FROM students WHERE school_id = $1 AND id = $2',
          [schoolId, id],
        );
        if (!student.rows[0]) throw notFound('Student not found');

        if (input.isPrimary) {
          const primary = await client.query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM student_guardians
               WHERE student_id = $1 AND is_primary AND valid_to IS NULL
             ) AS exists`,
            [id],
          );
          if (primary.rows[0]?.exists) {
            throw conflict(
              'This student already has a primary guardian. Update that link first.',
              'primary_guardian_exists',
            );
          }
        }

        const guardianId = await upsertGuardian(client, schoolId, input);
        const { rows } = await client.query(
          `INSERT INTO student_guardians
             (school_id, student_id, guardian_id, relationship_type, is_primary, portal_access_status)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            schoolId,
            id,
            guardianId,
            input.relationshipType,
            input.isPrimary,
            input.portalAccessStatus,
          ],
        );

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'student.guardian_linked',
          entityType: 'student',
          entityId: id,
          outcome: 'success',
          after: { guardianId, relationshipType: input.relationshipType },
          ...requestMeta(request),
        });

        return rows[0]!.id as string;
      });

      return reply.status(201).send({ id: guardian });
    },
  );

  /* ------------------------------- enrollment ------------------------------ */

  app.post(
    '/api/schools/:schoolId/students/:id/enrollments',
    { preHandler: requirePermission('students.admission.create') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(enrollmentInput, request.body);

      const created = await withTransaction(async (client) => {
        const student = await client.query<{ id: string }>(
          'SELECT id FROM students WHERE school_id = $1 AND id = $2',
          [schoolId, id],
        );
        if (!student.rows[0]) throw notFound('Student not found');

        const section = await loadSectionForAdmission(
          client,
          schoolId,
          input.sectionId,
          input.academicYearId,
        );

        await client.query(
          `INSERT INTO enrollments
             (school_id, student_id, academic_year_id, class_id, section_id, enrollment_status, starts_on)
           VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
          [schoolId, id, input.academicYearId, section.class_id, section.id, input.startsOn],
        );

        await client.query(
          `UPDATE students SET status = 'active' WHERE school_id = $1 AND id = $2`,
          [schoolId, id],
        );

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'student.enrolled',
          entityType: 'student',
          entityId: id,
          outcome: 'success',
          after: { academicYearId: input.academicYearId, sectionId: input.sectionId },
          ...requestMeta(request),
        });
        await recordActivity(client, {
          schoolId,
          entityType: 'student',
          entityId: id,
          eventType: 'student.enrolled',
          actorUserId: actor.userId,
          summary: `Enrolled in ${section.class_name} ${section.name} for ${section.year_name}`,
        });

        return loadStudentDetail(client, schoolId, id);
      });

      return reply.status(201).send(created);
    },
  );

  /* --------------------------------- portal -------------------------------- */

  app.get(
    '/api/schools/:schoolId/portal/children',
    { preHandler: requirePermission('guardian.student.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);

      const { rows } = await getPool().query<ChildRow>(
        `SELECT st.id AS student_id, st.admission_number, st.first_name, st.middle_name, st.last_name,
                c.name AS class_name, sec.name AS section_name, ay.name AS academic_year_name,
                sg.relationship_type, sg.is_primary, sg.portal_access_status
         FROM student_guardians sg
         JOIN guardians g ON g.id = sg.guardian_id AND g.school_id = sg.school_id
         JOIN students st ON st.id = sg.student_id AND st.school_id = sg.school_id
         LEFT JOIN LATERAL (
           SELECT e.class_id, e.section_id, e.academic_year_id
           FROM enrollments e
           WHERE e.student_id = st.id AND e.enrollment_status = 'active'
           ORDER BY e.starts_on DESC LIMIT 1
         ) en ON true
         LEFT JOIN classes c ON c.id = en.class_id
         LEFT JOIN sections sec ON sec.id = en.section_id
         LEFT JOIN academic_years ay ON ay.id = en.academic_year_id
         WHERE sg.school_id = $1
           AND g.user_id = $2
           AND sg.portal_access_status = 'verified'
           AND sg.valid_to IS NULL
         ORDER BY st.first_name`,
        [schoolId, actor.userId],
      );

      const children: ChildSummary[] = rows.map((row) => ({
        studentId: row.student_id,
        admissionNumber: row.admission_number,
        fullName: fullName(row.first_name, row.middle_name, row.last_name),
        className: row.class_name,
        sectionName: row.section_name,
        academicYearName: row.academic_year_name,
        relationshipType: row.relationship_type,
        isPrimary: row.is_primary,
        portalAccessStatus: row.portal_access_status,
      }));

      return { items: children };
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

interface SectionForAdmission {
  id: string;
  class_id: string;
  class_name: string;
  name: string;
  year_code: string;
  year_name: string;
}

async function loadSectionForAdmission(
  client: pg.PoolClient,
  schoolId: string,
  sectionId: string,
  academicYearId: string,
): Promise<SectionForAdmission> {
  const { rows } = await client.query<
    SectionForAdmission & { section_year_id: string }
  >(
    `SELECT sec.id, sec.class_id, sec.name, c.name AS class_name,
            ay.id AS section_year_id, ay.code AS year_code, ay.name AS year_name
     FROM sections sec
     JOIN classes c ON c.id = sec.class_id
     JOIN academic_years ay ON ay.id = sec.academic_year_id
     WHERE sec.school_id = $1 AND sec.id = $2`,
    [schoolId, sectionId],
  );
  const section = rows[0];
  if (!section) throw badRequest('Section not found in this school');
  if (section.section_year_id !== academicYearId) {
    throw badRequest('The section does not belong to the selected academic year');
  }
  return section;
}

async function nextAdmissionNumber(
  client: pg.PoolClient,
  schoolId: string,
  yearCode: string,
): Promise<string> {
  const { rows } = await client.query<{ value: string }>(
    `INSERT INTO school_counters (school_id, name, value)
     VALUES ($1, 'admission_number', 1)
     ON CONFLICT (school_id, name)
     DO UPDATE SET value = school_counters.value + 1
     RETURNING value`,
    [schoolId],
  );
  const sequence = toNumber(rows[0]?.value);
  const year = yearCode.split('-')[0] ?? String(new Date().getFullYear());
  return `ADM-${year}-${String(sequence).padStart(5, '0')}`;
}

async function upsertGuardian(
  client: pg.PoolClient,
  schoolId: string,
  guardian: {
    firstName: string;
    lastName?: string;
    email?: string;
    phone?: string;
  },
): Promise<string> {
  if (guardian.email) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM guardians
       WHERE school_id = $1 AND lower(email) = lower($2) LIMIT 1`,
      [schoolId, guardian.email],
    );
    if (existing.rows[0]) return existing.rows[0].id;
  } else if (guardian.phone) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM guardians
       WHERE school_id = $1 AND phone = $2 LIMIT 1`,
      [schoolId, guardian.phone],
    );
    if (existing.rows[0]) return existing.rows[0].id;
  }

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO guardians (school_id, first_name, last_name, email, phone)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [schoolId, guardian.firstName, guardian.lastName ?? null, guardian.email ?? null, guardian.phone ?? null],
  );
  return rows[0]!.id;
}

function assertSinglePrimary(flags: boolean[]): void {
  if (flags.filter(Boolean).length > 1) {
    throw badRequest('Only one guardian can be marked as primary', {
      guardians: ['Only one guardian can be primary'],
    });
  }
}

async function assertStudentVisible(
  client: pg.PoolClient,
  schoolId: string,
  studentId: string,
  assignments: Array<{ scopeType: string; scopeId: string | null }>,
): Promise<void> {
  const sectionIds = assignments
    .filter((assignment) => assignment.scopeType === 'section' && assignment.scopeId)
    .map((assignment) => assignment.scopeId as string);

  if (sectionIds.length === 0) {
    const exists = await client.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM students WHERE school_id = $1 AND id = $2) AS exists',
      [schoolId, studentId],
    );
    if (!exists.rows[0]?.exists) throw notFound('Student not found');
    return;
  }

  const visible = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM enrollments
       WHERE school_id = $1 AND student_id = $2 AND enrollment_status = 'active'
         AND section_id = ANY($3::uuid[])
     ) AS exists`,
    [schoolId, studentId, sectionIds],
  );
  if (!visible.rows[0]?.exists) throw notFound('Student not found');
}

async function loadStudentDetail(
  client: pg.PoolClient,
  schoolId: string,
  studentId: string,
): Promise<StudentDetail> {
  const { rows } = await client.query<StudentDetailRow>(
    `SELECT st.id, st.admission_number, st.first_name, st.middle_name, st.last_name,
            st.date_of_birth, st.status, st.created_at,
            c.name AS class_name, sec.name AS section_name, ay.name AS academic_year_name,
            (SELECT count(*) FROM student_guardians sg
              WHERE sg.student_id = st.id AND sg.valid_to IS NULL) AS guardian_count
     FROM students st
     LEFT JOIN LATERAL (
       SELECT e.class_id, e.section_id, e.academic_year_id
       FROM enrollments e
       WHERE e.student_id = st.id AND e.enrollment_status = 'active'
       ORDER BY e.starts_on DESC LIMIT 1
     ) en ON true
     LEFT JOIN classes c ON c.id = en.class_id
     LEFT JOIN sections sec ON sec.id = en.section_id
     LEFT JOIN academic_years ay ON ay.id = en.academic_year_id
     WHERE st.school_id = $1 AND st.id = $2`,
    [schoolId, studentId],
  );
  const student = rows[0];
  if (!student) throw notFound('Student not found');

  const guardians = await client.query<GuardianRow>(
    `SELECT g.id, g.first_name, g.last_name, g.email, g.phone,
            sg.relationship_type, sg.is_primary, sg.portal_access_status
     FROM student_guardians sg
     JOIN guardians g ON g.id = sg.guardian_id AND g.school_id = sg.school_id
     WHERE sg.school_id = $1 AND sg.student_id = $2 AND sg.valid_to IS NULL
     ORDER BY sg.is_primary DESC, g.first_name`,
    [schoolId, studentId],
  );

  const enrollments = await client.query<EnrollmentRow>(
    `SELECT e.id, e.academic_year_id, ay.name AS academic_year_name,
            e.class_id, c.name AS class_name, e.section_id, sec.name AS section_name,
            e.enrollment_status, e.starts_on, e.ends_on
     FROM enrollments e
     JOIN academic_years ay ON ay.id = e.academic_year_id
     JOIN classes c ON c.id = e.class_id
     JOIN sections sec ON sec.id = e.section_id
     WHERE e.school_id = $1 AND e.student_id = $2
     ORDER BY e.starts_on DESC`,
    [schoolId, studentId],
  );

  return {
    ...mapStudentSummary(student),
    middleName: student.middle_name,
    dateOfBirth: student.date_of_birth ? toIsoDate(student.date_of_birth) : null,
    createdAt: toIsoDateTime(student.created_at),
    guardians: guardians.rows.map(mapGuardian),
    enrollments: enrollments.rows.map(mapEnrollment),
  };
}

/* --------------------------------- mapping -------------------------------- */

interface StudentSummaryRow {
  id: string;
  admission_number: string;
  first_name: string;
  last_name: string | null;
  status: string;
  class_name: string | null;
  section_name: string | null;
  academic_year_name: string | null;
  guardian_count: string | number;
}

interface StudentDetailRow extends StudentSummaryRow {
  middle_name: string | null;
  date_of_birth: string | null;
  created_at: Date;
}

interface GuardianRow {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  relationship_type: string;
  is_primary: boolean;
  portal_access_status: GuardianRecord['portalAccessStatus'];
}

interface EnrollmentRow {
  id: string;
  academic_year_id: string;
  academic_year_name: string;
  class_id: string;
  class_name: string;
  section_id: string;
  section_name: string;
  enrollment_status: string;
  starts_on: string;
  ends_on: string | null;
}

interface ChildRow {
  student_id: string;
  admission_number: string;
  first_name: string;
  middle_name: string | null;
  last_name: string | null;
  class_name: string | null;
  section_name: string | null;
  academic_year_name: string | null;
  relationship_type: string;
  is_primary: boolean;
  portal_access_status: string;
}

function mapStudentSummary(row: StudentSummaryRow): StudentSummary {
  return {
    id: row.id,
    admissionNumber: row.admission_number,
    firstName: row.first_name,
    lastName: row.last_name,
    status: row.status,
    className: row.class_name,
    sectionName: row.section_name,
    academicYearName: row.academic_year_name,
    guardianCount: toNumber(row.guardian_count),
  };
}

function mapGuardian(row: GuardianRow): GuardianRecord {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    relationshipType: row.relationship_type,
    isPrimary: row.is_primary,
    portalAccessStatus: row.portal_access_status,
  };
}

function mapEnrollment(row: EnrollmentRow): EnrollmentRecord {
  return {
    id: row.id,
    academicYearId: row.academic_year_id,
    academicYearName: row.academic_year_name,
    classId: row.class_id,
    className: row.class_name,
    sectionId: row.section_id,
    sectionName: row.section_name,
    enrollmentStatus: row.enrollment_status,
    startsOn: toIsoDate(row.starts_on),
    endsOn: row.ends_on ? toIsoDate(row.ends_on) : null,
  };
}

/** Minimal RFC 4180 parser: quotes, escaped quotes and embedded newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }
  if (quoted) throw new Error('The CSV has an unclosed quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
