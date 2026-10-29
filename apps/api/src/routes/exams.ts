import { canAccessSection, fullName } from '@erp/core';
import {
  examInput,
  examSubjectInput,
  examUpdate,
  markEntryInput,
  uuid,
  type ExamRecord,
  type ExamSubject,
  type GradingBand,
  type GradingScheme,
  type MarkSheet,
  type MarkSheetRow,
  type ReportCard,
  type ReportCardSubject,
  type TranscriptExam,
  type TranscriptRecord,
  type TranscriptSubject,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { recordActivity, recordAudit } from '../lib/audit';
import { badRequest, conflict, notFound, parseInput } from '../lib/errors';
import { assertGuardianLinked } from '../lib/portal';
import { assertDateRange, toIsoDate, toIsoDateTime, toNumber } from '../lib/format';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const subjectParams = z.object({ schoolId: uuid, id: uuid, subjectId: uuid });
const reportParams = z.object({ schoolId: uuid, id: uuid, studentId: uuid });
const studentParams = z.object({ schoolId: uuid, studentId: uuid });
const listQuery = z.object({ academicYearId: uuid.optional() });
const marksQuery = z.object({ sectionId: uuid, subjectId: uuid });

const bandInput = z.object({
  minPercent: z.coerce.number().min(0).max(100),
  maxPercent: z.coerce.number().min(0).max(100),
  grade: z.string().trim().min(1).max(10),
  remark: z.string().trim().max(120).optional(),
});
const schemeInput = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  isDefault: z.boolean().default(false),
  bands: z.array(bandInput).min(1, 'Add at least one grade band').max(20),
});

/**
 * Exams, configurable grading and marks.
 *
 * Results are only visible to guardians after publication. Marks cannot be
 * edited once an exam is published; an explicit unpublish reopens entry and is
 * audited. Report cards are computed from marks and the scheme's bands.
 */
export async function registerExamRoutes(app: FastifyInstance): Promise<void> {
  /* ----------------------------- grading schemes --------------------------- */

  app.get(
    '/api/schools/:schoolId/grading-schemes',
    { preHandler: requirePermission('exams.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      return { items: await loadSchemes(getPool(), schoolId) };
    },
  );

  app.post(
    '/api/schools/:schoolId/grading-schemes',
    { preHandler: requirePermission('exams.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(schemeInput, request.body);
      assertBands(input.bands);

      const schemeId = await withTransaction(async (client) => {
        if (input.isDefault) {
          await client.query(
            'UPDATE grading_schemes SET is_default = false WHERE school_id = $1 AND is_default',
            [schoolId],
          );
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO grading_schemes (school_id, code, name, is_default)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [schoolId, input.code, input.name, input.isDefault],
        );
        const id = rows[0]!.id;
        for (const band of input.bands) {
          await client.query(
            `INSERT INTO grading_bands (school_id, scheme_id, min_percent, max_percent, grade, remark)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [schoolId, id, band.minPercent, band.maxPercent, band.grade, band.remark ?? null],
          );
        }
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'exams.grading_scheme_created',
          entityType: 'grading_scheme',
          entityId: id,
          outcome: 'success',
          after: input,
          ...requestMeta(request),
        });
        return id;
      });

      const schemes = await loadSchemes(getPool(), schoolId);
      return reply.status(201).send(schemes.find((scheme) => scheme.id === schemeId));
    },
  );

  /* ---------------------------------- exams -------------------------------- */

  app.get(
    '/api/schools/:schoolId/exams',
    { preHandler: requirePermission('exams.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(listQuery, request.query);
      const yearId =
        query.academicYearId ??
        (
          await getPool().query<{ id: string }>(
            `SELECT id FROM academic_years WHERE school_id = $1 AND status = 'active' LIMIT 1`,
            [schoolId],
          )
        ).rows[0]?.id ??
        null;
      if (!yearId) return { items: [] };

      return { items: await loadExams(getPool(), schoolId, yearId) };
    },
  );

  app.post(
    '/api/schools/:schoolId/exams',
    { preHandler: requirePermission('exams.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(examInput, request.body);
      assertDateRange(input.startsOn, input.endsOn);

      const examId = await withTransaction(async (client) => {
        await assertYearAndScheme(client, schoolId, input.academicYearId, input.gradingSchemeId);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO exams
             (school_id, academic_year_id, name, exam_type, starts_on, ends_on,
              grading_scheme_id, pass_percent, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            schoolId,
            input.academicYearId,
            input.name,
            input.examType,
            input.startsOn,
            input.endsOn,
            input.gradingSchemeId,
            input.passPercent,
            actor.userId,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'exams.exam_created',
          entityType: 'exam',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: input,
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });

      const exams = await loadExams(getPool(), schoolId, null);
      return reply.status(201).send(exams.find((exam) => exam.id === examId));
    },
  );

  app.patch(
    '/api/schools/:schoolId/exams/:id',
    { preHandler: requirePermission('exams.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(examUpdate, request.body);

      await withTransaction(async (client) => {
        const existing = await client.query<{
          id: string;
          academic_year_id: string;
          name: string;
          exam_type: string;
          starts_on: string;
          ends_on: string;
          grading_scheme_id: string;
          pass_percent: string;
          status: 'draft' | 'published';
        }>(
          `SELECT id, academic_year_id, name, exam_type, starts_on, ends_on,
                  grading_scheme_id, pass_percent, status
           FROM exams WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Exam not found');
        if (row.status === 'published') {
          throw conflict('Unpublish the exam before editing its details', 'exam_published');
        }

        const startsOn = input.startsOn ?? toIsoDate(row.starts_on);
        const endsOn = input.endsOn ?? toIsoDate(row.ends_on);
        assertDateRange(startsOn, endsOn);
        if (input.gradingSchemeId) {
          const scheme = await client.query(
            'SELECT 1 FROM grading_schemes WHERE school_id = $1 AND id = $2',
            [schoolId, input.gradingSchemeId],
          );
          if (scheme.rowCount === 0) throw notFound('Grading scheme not found');
        }

        await client.query(
          `UPDATE exams
           SET name = $3, exam_type = $4, starts_on = $5, ends_on = $6,
               grading_scheme_id = $7, pass_percent = $8
           WHERE school_id = $1 AND id = $2`,
          [
            schoolId,
            id,
            input.name ?? row.name,
            input.examType ?? row.exam_type,
            startsOn,
            endsOn,
            input.gradingSchemeId ?? row.grading_scheme_id,
            input.passPercent ?? row.pass_percent,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'exams.exam_updated',
          entityType: 'exam',
          entityId: id,
          outcome: 'success',
          before: row,
          after: input,
          ...requestMeta(request),
        });
      });

      const exams = await loadExams(getPool(), schoolId, null);
      return exams.find((exam) => exam.id === id);
    },
  );

  app.delete(
    '/api/schools/:schoolId/exams/:id',
    { preHandler: requirePermission('exams.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);

      await withTransaction(async (client) => {
        const existing = await client.query<{ status: 'draft' | 'published' }>(
          'SELECT status FROM exams WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Exam not found');
        if (row.status === 'published') {
          throw conflict('Unpublish the exam before deleting it', 'exam_published');
        }
        const marks = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM exam_marks m
           JOIN exam_subjects es ON es.id = m.exam_subject_id
           WHERE es.school_id = $1 AND es.exam_id = $2`,
          [schoolId, id],
        );
        if (Number(marks.rows[0]!.count) > 0) {
          throw badRequest('This exam already has marks and cannot be deleted');
        }
        await client.query('DELETE FROM exam_subjects WHERE school_id = $1 AND exam_id = $2', [
          schoolId,
          id,
        ]);
        await client.query('DELETE FROM exams WHERE school_id = $1 AND id = $2', [schoolId, id]);
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'exams.exam_deleted',
          entityType: 'exam',
          entityId: id,
          outcome: 'success',
          ...requestMeta(request),
        });
      });

      return reply.status(204).send();
    },
  );

  /* ------------------------------ exam subjects ---------------------------- */

  app.post(
    '/api/schools/:schoolId/exams/:id/subjects',
    { preHandler: requirePermission('exams.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(examSubjectInput, request.body);

      const created = await withTransaction(async (client) => {
        const exam = await client.query<{ status: 'draft' | 'published' }>(
          'SELECT status FROM exams WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        if (!exam.rows[0]) throw notFound('Exam not found');
        if (exam.rows[0].status === 'published') {
          throw conflict('Unpublish the exam before changing its subjects', 'exam_published');
        }
        const subject = await client.query('SELECT 1 FROM subjects WHERE school_id = $1 AND id = $2', [
          schoolId,
          input.subjectId,
        ]);
        if (subject.rowCount === 0) throw notFound('Subject not found');

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO exam_subjects (school_id, exam_id, subject_id, max_marks, pass_marks)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [schoolId, id, input.subjectId, input.maxMarks, input.passMarks],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'exams.subject_added',
          entityType: 'exam',
          entityId: id,
          outcome: 'success',
          after: input,
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });

      return reply.status(201).send({ id: created });
    },
  );

  app.delete(
    '/api/schools/:schoolId/exams/:id/subjects/:subjectId',
    { preHandler: requirePermission('exams.manage') },
    async (request, reply) => {
      const { schoolId, id, subjectId } = parseInput(subjectParams, request.params);
      const actor = getActor(request);

      await withTransaction(async (client) => {
        const exam = await client.query<{ status: 'draft' | 'published' }>(
          'SELECT status FROM exams WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        if (!exam.rows[0]) throw notFound('Exam not found');
        if (exam.rows[0].status === 'published') {
          throw conflict('Unpublish the exam before changing its subjects', 'exam_published');
        }
        const marks = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM exam_marks
           WHERE school_id = $1 AND exam_subject_id = $2`,
          [schoolId, subjectId],
        );
        if (Number(marks.rows[0]!.count) > 0) {
          throw badRequest('This exam subject already has marks and cannot be removed');
        }
        const { rowCount } = await client.query(
          'DELETE FROM exam_subjects WHERE school_id = $1 AND exam_id = $2 AND id = $3',
          [schoolId, id, subjectId],
        );
        if (rowCount === 0) throw notFound('Exam subject not found');
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'exams.subject_removed',
          entityType: 'exam',
          entityId: id,
          outcome: 'success',
          after: { subjectId },
          ...requestMeta(request),
        });
      });

      return reply.status(204).send();
    },
  );

  /* ---------------------------------- marks -------------------------------- */

  app.get(
    '/api/schools/:schoolId/exams/:id/marks',
    { preHandler: requirePermission('exams.view') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const query = parseInput(marksQuery, request.query);
      const actor = getActor(request);
      if (!canAccessSection(actor, query.sectionId)) throw notFound('Section not found');
      return buildMarkSheet(getPool(), schoolId, id, query.sectionId, query.subjectId);
    },
  );

  app.post(
    '/api/schools/:schoolId/exams/:id/marks',
    { preHandler: requirePermission('exams.marks.record') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(markEntryInput, request.body);
      if (!canAccessSection(actor, input.sectionId)) throw notFound('Section not found');

      const result = await withTransaction(async (client) => {
        const exam = await client.query<{ status: 'draft' | 'published' }>(
          'SELECT status FROM exams WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        if (!exam.rows[0]) throw notFound('Exam not found');
        if (exam.rows[0].status === 'published') {
          throw conflict('Marks are locked because results are published', 'exam_published');
        }

        const subject = await client.query<{ id: string; max_marks: string }>(
          'SELECT id, max_marks FROM exam_subjects WHERE school_id = $1 AND exam_id = $2 AND id = $3',
          [schoolId, id, input.examSubjectId],
        );
        const subjectRow = subject.rows[0];
        if (!subjectRow) throw notFound('Exam subject not found');
        const maxMarks = Number(subjectRow.max_marks);

        const studentIds = [...new Set(input.entries.map((entry) => entry.studentId))];
        const enrolled = await client.query<{ student_id: string }>(
          `SELECT e.student_id FROM enrollments e
           WHERE e.school_id = $1 AND e.section_id = $2
             AND e.enrollment_status = 'active'
             AND e.student_id = ANY($3::uuid[])`,
          [schoolId, input.sectionId, studentIds],
        );
        const allowed = new Set(enrolled.rows.map((row) => row.student_id));
        const missing = studentIds.filter((studentId) => !allowed.has(studentId));
        if (missing.length > 0) {
          throw badRequest('Some students are not enrolled in this section', {
            entries: [`Not enrolled: ${missing.join(', ')}`],
          });
        }

        let saved = 0;
        for (const entry of input.entries) {
          if (!entry.isAbsent && entry.marksObtained === null) {
            throw badRequest('Enter marks or mark the student absent', {
              entries: ['Every row needs marks or an absence flag'],
            });
          }
          if (entry.marksObtained !== null && entry.marksObtained > maxMarks) {
            throw badRequest(`Marks cannot exceed the maximum of ${maxMarks}`, {
              entries: [`A mark is above ${maxMarks}`],
            });
          }
          await client.query(
            `INSERT INTO exam_marks
               (school_id, exam_subject_id, student_id, marks_obtained, is_absent, entered_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (exam_subject_id, student_id) DO UPDATE
               SET marks_obtained = EXCLUDED.marks_obtained,
                   is_absent = EXCLUDED.is_absent,
                   entered_by = EXCLUDED.entered_by,
                   entered_at = now()`,
            [
              schoolId,
              input.examSubjectId,
              entry.studentId,
              entry.isAbsent ? null : entry.marksObtained,
              entry.isAbsent,
              actor.userId,
            ],
          );
          saved += 1;
        }

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'exams.marks_saved',
          entityType: 'exam',
          entityId: id,
          outcome: 'success',
          after: { sectionId: input.sectionId, examSubjectId: input.examSubjectId, saved },
          ...requestMeta(request),
        });
        await recordActivity(client, {
          schoolId,
          entityType: 'section',
          entityId: input.sectionId,
          eventType: 'exams.marks_saved',
          actorUserId: actor.userId,
          summary: `${saved} marks saved for an exam`,
        });

        return saved;
      });

      return buildMarkSheet(
        getPool(),
        schoolId,
        id,
        input.sectionId,
        input.examSubjectId,
        result,
      );
    },
  );

  /* ------------------------------ publish / results ------------------------ */

  app.post(
    '/api/schools/:schoolId/exams/:id/publish',
    { preHandler: requirePermission('exams.results.publish') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);

      await withTransaction(async (client) => {
        const exam = await client.query<{ status: 'draft' | 'published' }>(
          'SELECT status FROM exams WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        if (!exam.rows[0]) throw notFound('Exam not found');
        if (exam.rows[0].status === 'published') {
          throw conflict('Results are already published', 'already_published');
        }

        const missing = await client.query<{ name: string }>(
          `SELECT sub.name
           FROM exam_subjects es
           JOIN subjects sub ON sub.id = es.subject_id
           WHERE es.school_id = $1 AND es.exam_id = $2
             AND NOT EXISTS (
               SELECT 1 FROM exam_marks m WHERE m.exam_subject_id = es.id
             )
           ORDER BY sub.name`,
          [schoolId, id],
        );
        if (missing.rows.length > 0) {
          throw badRequest('Enter marks for every subject before publishing', {
            subjects: [`No marks yet for ${missing.rows.map((row) => row.name).join(', ')}`],
          });
        }

        await client.query(
          `UPDATE exams SET status = 'published', published_at = now(), published_by = $3
           WHERE school_id = $1 AND id = $2`,
          [schoolId, id, actor.userId],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'exams.results_published',
          entityType: 'exam',
          entityId: id,
          outcome: 'success',
          ...requestMeta(request),
        });
      });

      const exams = await loadExams(getPool(), schoolId, null);
      return exams.find((exam) => exam.id === id);
    },
  );

  app.post(
    '/api/schools/:schoolId/exams/:id/unpublish',
    { preHandler: requirePermission('exams.results.publish') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);

      await withTransaction(async (client) => {
        const { rowCount } = await client.query(
          `UPDATE exams
           SET status = 'draft', published_at = NULL, published_by = NULL
           WHERE school_id = $1 AND id = $2 AND status = 'published'`,
          [schoolId, id],
        );
        if (rowCount === 0) throw conflict('Results are not currently published', 'not_published');
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'exams.results_unpublished',
          entityType: 'exam',
          entityId: id,
          outcome: 'success',
          reason: 'Reopened for marks correction',
          ...requestMeta(request),
        });
      });

      const exams = await loadExams(getPool(), schoolId, null);
      return exams.find((exam) => exam.id === id);
    },
  );

  app.get(
    '/api/schools/:schoolId/exams/:id/report-cards/:studentId',
    { preHandler: requirePermission('exams.view') },
    async (request) => {
      const { schoolId, id, studentId } = parseInput(reportParams, request.params);
      const actor = getActor(request);
      const section = await getPool().query<{ section_id: string }>(
        `SELECT section_id FROM enrollments
         WHERE school_id = $1 AND student_id = $2 AND enrollment_status = 'active'
         ORDER BY starts_on DESC LIMIT 1`,
        [schoolId, studentId],
      );
      const sectionId = section.rows[0]?.section_id;
      if (!sectionId || !canAccessSection(actor, sectionId)) {
        throw notFound('Student not found');
      }
      return buildReportCard(getPool(), schoolId, id, studentId);
    },
  );

  /* ------------------------------- transcripts ------------------------------ */

  app.get(
    '/api/schools/:schoolId/students/:studentId/transcript',
    { preHandler: requirePermission('exams.view') },
    async (request) => {
      const { schoolId, studentId } = parseInput(studentParams, request.params);
      const query = parseInput(listQuery, request.query);
      const actor = getActor(request);
      const section = await activeSection(getPool(), schoolId, studentId);
      if (!section || !canAccessSection(actor, section)) throw notFound('Student not found');
      return buildTranscript(getPool(), schoolId, studentId, query.academicYearId);
    },
  );

  app.get(
    '/api/schools/:schoolId/students/:studentId/transcript/print',
    { preHandler: requirePermission('exams.view') },
    async (request, reply) => {
      const { schoolId, studentId } = parseInput(studentParams, request.params);
      const query = parseInput(listQuery, request.query);
      const actor = getActor(request);
      const section = await activeSection(getPool(), schoolId, studentId);
      if (!section || !canAccessSection(actor, section)) throw notFound('Student not found');
      const transcript = await buildTranscript(getPool(), schoolId, studentId, query.academicYearId);
      const school = await loadSchoolHeader(schoolId);
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .send(renderTranscript(transcript, school));
    },
  );

  /* ------------------------------ guardian portal --------------------------- */

  app.get(
    '/api/schools/:schoolId/portal/children/:studentId/transcript',
    { preHandler: requirePermission('guardian.student.view') },
    async (request) => {
      const { schoolId, studentId } = parseInput(studentParams, request.params);
      const query = parseInput(listQuery, request.query);
      const actor = getActor(request);
      await assertGuardianLinked(getPool(), schoolId, actor.userId, studentId);
      return buildTranscript(getPool(), schoolId, studentId, query.academicYearId);
    },
  );

  app.get(
    '/api/schools/:schoolId/portal/children/:studentId/transcript/print',
    { preHandler: requirePermission('guardian.student.view') },
    async (request, reply) => {
      const { schoolId, studentId } = parseInput(studentParams, request.params);
      const query = parseInput(listQuery, request.query);
      const actor = getActor(request);
      await assertGuardianLinked(getPool(), schoolId, actor.userId, studentId);
      const transcript = await buildTranscript(getPool(), schoolId, studentId, query.academicYearId);
      const school = await loadSchoolHeader(schoolId);
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .send(renderTranscript(transcript, school));
    },
  );

  /* ------------------------------ guardian results -------------------------- */

  app.get(
    '/api/schools/:schoolId/portal/children/:studentId/results',
    { preHandler: requirePermission('guardian.student.view') },
    async (request) => {
      const { schoolId, studentId } = parseInput(studentParams, request.params);
      const actor = getActor(request);
      await assertGuardianLinked(getPool(), schoolId, actor.userId, studentId);

      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id FROM exams
         WHERE school_id = $1 AND status = 'published'
         ORDER BY starts_on DESC`,
        [schoolId],
      );
      const items = [];
      for (const row of rows) {
        items.push(await buildReportCard(getPool(), schoolId, row.id, studentId));
      }
      return { items };
    },
  );
}

/* --------------------------------- loading -------------------------------- */

async function loadSchemes(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
): Promise<GradingScheme[]> {
  const schemes = await client.query<{
    id: string;
    code: string;
    name: string;
    is_default: boolean;
  }>(
    `SELECT id, code, name, is_default FROM grading_schemes
     WHERE school_id = $1 ORDER BY is_default DESC, name`,
    [schoolId],
  );
  const bands = await client.query<{
    id: string;
    scheme_id: string;
    min_percent: string;
    max_percent: string;
    grade: string;
    remark: string | null;
  }>(
    `SELECT id, scheme_id, min_percent, max_percent, grade, remark
     FROM grading_bands WHERE school_id = $1 ORDER BY min_percent DESC`,
    [schoolId],
  );

  return schemes.rows.map((scheme) => ({
    id: scheme.id,
    code: scheme.code,
    name: scheme.name,
    isDefault: scheme.is_default,
    bands: bands.rows
      .filter((band) => band.scheme_id === scheme.id)
      .map(
        (band): GradingBand => ({
          id: band.id,
          minPercent: toNumber(band.min_percent),
          maxPercent: toNumber(band.max_percent),
          grade: band.grade,
          remark: band.remark,
        }),
      ),
  }));
}

async function loadExams(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  yearId: string | null,
): Promise<ExamRecord[]> {
  const exams = await client.query<{
    id: string;
    academic_year_id: string;
    academic_year_name: string;
    name: string;
    exam_type: string;
    starts_on: string;
    ends_on: string;
    grading_scheme_id: string;
    grading_scheme_name: string;
    pass_percent: string;
    status: 'draft' | 'published';
    published_at: Date | null;
    published_by_name: string | null;
  }>(
    `SELECT e.id, e.academic_year_id, ay.name AS academic_year_name, e.name, e.exam_type,
            e.starts_on, e.ends_on, e.grading_scheme_id, gs.name AS grading_scheme_name,
            e.pass_percent, e.status, e.published_at, u.display_name AS published_by_name
     FROM exams e
     JOIN academic_years ay ON ay.id = e.academic_year_id AND ay.school_id = e.school_id
     JOIN grading_schemes gs ON gs.id = e.grading_scheme_id AND gs.school_id = e.school_id
     LEFT JOIN users u ON u.id = e.published_by
     WHERE e.school_id = $1 ${yearId ? 'AND e.academic_year_id = $2' : ''}
     ORDER BY e.starts_on DESC`,
    yearId ? [schoolId, yearId] : [schoolId],
  );
  if (exams.rows.length === 0) return [];

  const ids = exams.rows.map((exam) => exam.id);
  const subjects = await client.query<{
    id: string;
    exam_id: string;
    subject_id: string;
    subject_code: string;
    subject_name: string;
    max_marks: string;
    pass_marks: string;
    marks_entered: string;
  }>(
    `SELECT es.id, es.exam_id, es.subject_id, sub.code AS subject_code, sub.name AS subject_name,
            es.max_marks, es.pass_marks,
            (SELECT count(*) FROM exam_marks m WHERE m.exam_subject_id = es.id)::text AS marks_entered
     FROM exam_subjects es
     JOIN subjects sub ON sub.id = es.subject_id AND sub.school_id = es.school_id
     WHERE es.school_id = $1 AND es.exam_id = ANY($2::uuid[])
     ORDER BY sub.name`,
    [schoolId, ids],
  );

  return exams.rows.map((exam) => ({
    id: exam.id,
    academicYearId: exam.academic_year_id,
    academicYearName: exam.academic_year_name,
    name: exam.name,
    examType: exam.exam_type,
    startsOn: toIsoDate(exam.starts_on),
    endsOn: toIsoDate(exam.ends_on),
    gradingSchemeId: exam.grading_scheme_id,
    gradingSchemeName: exam.grading_scheme_name,
    passPercent: toNumber(exam.pass_percent),
    status: exam.status,
    publishedAt: exam.published_at ? toIsoDateTime(exam.published_at) : null,
    publishedByName: exam.published_by_name,
    subjects: subjects.rows
      .filter((subject) => subject.exam_id === exam.id)
      .map(
        (subject): ExamSubject => ({
          id: subject.id,
          subjectId: subject.subject_id,
          subjectCode: subject.subject_code,
          subjectName: subject.subject_name,
          maxMarks: toNumber(subject.max_marks),
          passMarks: toNumber(subject.pass_marks),
          marksEntered: toNumber(subject.marks_entered),
        }),
      ),
  }));
}

interface MarkSheetContext {
  exam: {
    id: string;
    status: 'draft' | 'published';
    grading_scheme_id: string;
    pass_percent: string;
    name: string;
  };
  subject: {
    id: string;
    subject_id: string;
    subject_code: string;
    subject_name: string;
    max_marks: string;
    pass_marks: string;
    marks_entered: string;
  };
  section: { id: string; class_name: string; name: string };
  bands: GradingBand[];
}

async function loadMarkSheetContext(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  examId: string,
  sectionId: string,
  subjectId: string,
): Promise<MarkSheetContext> {
  const exam = await client.query<{
    id: string;
    status: 'draft' | 'published';
    grading_scheme_id: string;
    pass_percent: string;
    name: string;
  }>(
    'SELECT id, status, grading_scheme_id, pass_percent, name FROM exams WHERE school_id = $1 AND id = $2',
    [schoolId, examId],
  );
  if (!exam.rows[0]) throw notFound('Exam not found');

  const subject = await client.query<{
    id: string;
    subject_id: string;
    subject_code: string;
    subject_name: string;
    max_marks: string;
    pass_marks: string;
    marks_entered: string;
  }>(
    `SELECT es.id, es.subject_id, sub.code AS subject_code, sub.name AS subject_name,
            es.max_marks, es.pass_marks,
            (SELECT count(*) FROM exam_marks m WHERE m.exam_subject_id = es.id)::text AS marks_entered
     FROM exam_subjects es
     JOIN subjects sub ON sub.id = es.subject_id AND sub.school_id = es.school_id
     WHERE es.school_id = $1 AND es.exam_id = $2 AND es.id = $3`,
    [schoolId, examId, subjectId],
  );
  if (!subject.rows[0]) throw notFound('Exam subject not found');

  const section = await client.query<{ id: string; class_name: string; name: string }>(
    `SELECT sec.id, c.name AS class_name, sec.name
     FROM sections sec JOIN classes c ON c.id = sec.class_id AND c.school_id = sec.school_id
     WHERE sec.school_id = $1 AND sec.id = $2`,
    [schoolId, sectionId],
  );
  if (!section.rows[0]) throw notFound('Section not found');

  const bands = await client.query<{
    id: string;
    min_percent: string;
    max_percent: string;
    grade: string;
    remark: string | null;
  }>(
    `SELECT id, min_percent, max_percent, grade, remark FROM grading_bands
     WHERE school_id = $1 AND scheme_id = $2 ORDER BY min_percent DESC`,
    [schoolId, exam.rows[0].grading_scheme_id],
  );

  return {
    exam: exam.rows[0],
    subject: subject.rows[0],
    section: section.rows[0],
    bands: bands.rows.map((band) => ({
      id: band.id,
      minPercent: toNumber(band.min_percent),
      maxPercent: toNumber(band.max_percent),
      grade: band.grade,
      remark: band.remark,
    })),
  };
}

async function buildMarkSheet(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  examId: string,
  sectionId: string,
  subjectId: string,
  justSaved?: number,
): Promise<MarkSheet> {
  const context = await loadMarkSheetContext(client, schoolId, examId, sectionId, subjectId);
  const rows = await client.query<{
    student_id: string;
    admission_number: string;
    first_name: string;
    middle_name: string | null;
    last_name: string | null;
    marks_obtained: string | null;
    is_absent: boolean | null;
    entered_by_name: string | null;
    updated_at: Date | null;
  }>(
    `SELECT st.id AS student_id, st.admission_number, st.first_name, st.middle_name, st.last_name,
            m.marks_obtained, m.is_absent, u.display_name AS entered_by_name, m.updated_at
     FROM enrollments e
     JOIN students st ON st.id = e.student_id AND st.school_id = e.school_id
     LEFT JOIN exam_marks m ON m.student_id = st.id AND m.exam_subject_id = $3
       AND m.school_id = e.school_id
     LEFT JOIN users u ON u.id = m.entered_by
     WHERE e.school_id = $1 AND e.section_id = $2 AND e.enrollment_status = 'active'
     ORDER BY st.first_name, st.last_name, st.admission_number`,
    [schoolId, sectionId, context.subject.id],
  );

  const maxMarks = Number(context.subject.max_marks);
  const markRows: MarkSheetRow[] = rows.rows.map((row) => {
    const marks = row.marks_obtained === null ? null : toNumber(row.marks_obtained);
    return {
      studentId: row.student_id,
      admissionNumber: row.admission_number,
      fullName: fullName(row.first_name, row.middle_name, row.last_name),
      className: context.section.class_name,
      sectionName: context.section.name,
      marksObtained: marks,
      isAbsent: row.is_absent ?? false,
      grade:
        marks === null || row.is_absent
          ? null
          : gradeFor((marks / maxMarks) * 100, context.bands),
      enteredByName: row.entered_by_name,
      updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
    };
  });

  return {
    exam: {
      id: context.exam.id,
      academicYearId: '',
      academicYearName: '',
      name: context.exam.name,
      examType: '',
      startsOn: '',
      endsOn: '',
      gradingSchemeId: context.exam.grading_scheme_id,
      gradingSchemeName: '',
      passPercent: toNumber(context.exam.pass_percent),
      status: context.exam.status,
      publishedAt: null,
      publishedByName: null,
      subjects: [],
    },
    subject: {
      id: context.subject.id,
      subjectId: context.subject.subject_id,
      subjectCode: context.subject.subject_code,
      subjectName: context.subject.subject_name,
      maxMarks,
      passMarks: toNumber(context.subject.pass_marks),
      marksEntered: justSaved ?? toNumber(context.subject.marks_entered),
    },
    section: {
      id: context.section.id,
      className: context.section.class_name,
      name: context.section.name,
    },
    canRecord: context.exam.status === 'draft',
    rows: markRows,
  };
}

async function buildReportCard(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  examId: string,
  studentId: string,
): Promise<ReportCard> {
  const exam = await client.query<{
    id: string;
    name: string;
    status: 'draft' | 'published';
    published_at: Date | null;
    grading_scheme_id: string;
    pass_percent: string;
  }>(
    `SELECT id, name, status, published_at, grading_scheme_id, pass_percent
     FROM exams WHERE school_id = $1 AND id = $2`,
    [schoolId, examId],
  );
  const examRow = exam.rows[0];
  if (!examRow) throw notFound('Exam not found');

  const student = await client.query<{
    id: string;
    admission_number: string;
    first_name: string;
    middle_name: string | null;
    last_name: string | null;
    class_name: string | null;
    section_name: string | null;
  }>(
    `SELECT st.id, st.admission_number, st.first_name, st.middle_name, st.last_name,
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

  const [subjects, bands] = await Promise.all([
    client.query<{
      subject_id: string;
      subject_name: string;
      max_marks: string;
      pass_marks: string;
      marks_obtained: string | null;
      is_absent: boolean | null;
    }>(
      `SELECT es.subject_id, sub.name AS subject_name, es.max_marks, es.pass_marks,
              m.marks_obtained, m.is_absent
       FROM exam_subjects es
       JOIN subjects sub ON sub.id = es.subject_id AND sub.school_id = es.school_id
       LEFT JOIN exam_marks m ON m.exam_subject_id = es.id AND m.student_id = $3
       WHERE es.school_id = $1 AND es.exam_id = $2
       ORDER BY sub.name`,
      [schoolId, examId, studentId],
    ),
    client.query<{
      min_percent: string;
      max_percent: string;
      grade: string;
      remark: string | null;
    }>(
      `SELECT min_percent, max_percent, grade, remark FROM grading_bands
       WHERE school_id = $1 AND scheme_id = $2 ORDER BY min_percent DESC`,
      [schoolId, examRow.grading_scheme_id],
    ),
  ]);

  const bandsMapped: GradingBand[] = bands.rows.map((band) => ({
    id: '',
    minPercent: toNumber(band.min_percent),
    maxPercent: toNumber(band.max_percent),
    grade: band.grade,
    remark: band.remark,
  }));

  let totalMax = 0;
  let totalObtained = 0;
  let incomplete = false;
  let failedSubject = false;

  const subjectRows: ReportCardSubject[] = subjects.rows.map((subject) => {
    const maxMarks = Number(subject.max_marks);
    const passMarks = Number(subject.pass_marks);
    const marks = subject.marks_obtained === null ? null : toNumber(subject.marks_obtained);
    const isAbsent = subject.is_absent ?? false;
    totalMax += maxMarks;
    if (marks === null) {
      incomplete = true;
    } else {
      totalObtained += marks;
    }
    const percentage = marks === null ? null : (marks / maxMarks) * 100;
    const passed = marks === null ? null : marks >= passMarks;
    if (passed === false) failedSubject = true;
    return {
      subjectId: subject.subject_id,
      subjectName: subject.subject_name,
      maxMarks,
      passMarks,
      marksObtained: marks,
      isAbsent,
      grade: percentage === null ? null : gradeFor(percentage, bandsMapped),
      passed,
    };
  });

  const percentage = incomplete || totalMax === 0 ? null : (totalObtained / totalMax) * 100;
  const overallGrade = percentage === null ? null : gradeFor(percentage, bandsMapped);
  const result: ReportCard['result'] =
    incomplete || totalMax === 0
      ? 'incomplete'
      : failedSubject || percentage! < toNumber(examRow.pass_percent)
        ? 'fail'
        : 'pass';

  return {
    studentId: studentRow.id,
    studentName: fullName(studentRow.first_name, studentRow.middle_name, studentRow.last_name),
    admissionNumber: studentRow.admission_number,
    className: studentRow.class_name,
    sectionName: studentRow.section_name,
    examId: examRow.id,
    examName: examRow.name,
    examStatus: examRow.status,
    publishedAt: examRow.published_at ? examRow.published_at.toISOString() : null,
    subjects: subjectRows,
    totalMax,
    totalObtained,
    percentage,
    overallGrade,
    result,
  };
}

function gradeFor(percentage: number, bands: GradingBand[]): string | null {
  for (const band of bands) {
    if (percentage >= band.minPercent && percentage <= band.maxPercent) return band.grade;
  }
  return null;
}

function assertBands(bands: Array<{ minPercent: number; maxPercent: number; grade: string }>): void {
  const sorted = [...bands].sort((a, b) => a.minPercent - b.minPercent);
  const grades = new Set<string>();
  for (const [index, band] of sorted.entries()) {
    if (band.maxPercent < band.minPercent) {
      throw badRequest('A grade band ends before it starts', {
        bands: [`${band.grade}: maximum must be at least the minimum`],
      });
    }
    if (grades.has(band.grade)) {
      throw badRequest('Grade names must be unique within a scheme', {
        bands: [`Duplicate grade ${band.grade}`],
      });
    }
    grades.add(band.grade);
    const next = sorted[index + 1];
    if (next && next.minPercent <= band.maxPercent) {
      throw badRequest('Grade bands cannot overlap', {
        bands: [`${band.grade} overlaps ${next.grade}`],
      });
    }
  }
}

async function assertYearAndScheme(
  client: pg.PoolClient,
  schoolId: string,
  yearId: string,
  schemeId: string,
): Promise<void> {
  const year = await client.query('SELECT 1 FROM academic_years WHERE school_id = $1 AND id = $2', [
    schoolId,
    yearId,
  ]);
  if (year.rowCount === 0) throw notFound('Academic year not found');
  const scheme = await client.query(
    'SELECT 1 FROM grading_schemes WHERE school_id = $1 AND id = $2',
    [schoolId, schemeId],
  );
  if (scheme.rowCount === 0) throw notFound('Grading scheme not found');
}

/* -------------------------------- transcripts ----------------------------- */

async function activeSection(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  studentId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ section_id: string }>(
    `SELECT section_id FROM enrollments
     WHERE school_id = $1 AND student_id = $2 AND enrollment_status = 'active'
     ORDER BY starts_on DESC LIMIT 1`,
    [schoolId, studentId],
  );
  return rows[0]?.section_id ?? null;
}

async function buildTranscript(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  studentId: string,
  academicYearId?: string,
): Promise<TranscriptRecord> {
  const student = await client.query<{
    id: string;
    admission_number: string;
    first_name: string;
    middle_name: string | null;
    last_name: string | null;
    class_name: string | null;
    section_name: string | null;
    year_id: string | null;
  }>(
    `SELECT st.id, st.admission_number, st.first_name, st.middle_name, st.last_name,
            c.name AS class_name, sec.name AS section_name, e.academic_year_id AS year_id
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

  const yearId = academicYearId ?? studentRow.year_id;
  if (!yearId) throw badRequest('The student is not enrolled in an academic year yet');

  const year = await client.query<{ id: string; name: string }>(
    'SELECT id, name FROM academic_years WHERE school_id = $1 AND id = $2',
    [schoolId, yearId],
  );
  const yearRow = year.rows[0];
  if (!yearRow) throw notFound('Academic year not found');

  const exams = await client.query<{
    id: string;
    exam_type: string;
    starts_on: string;
    ends_on: string;
  }>(
    `SELECT id, exam_type, starts_on, ends_on FROM exams
     WHERE school_id = $1 AND academic_year_id = $2 AND status = 'published'
     ORDER BY starts_on, name`,
    [schoolId, yearId],
  );

  const examRows: TranscriptExam[] = [];
  let cumulativeMax = 0;
  let cumulativeObtained = 0;

  for (const exam of exams.rows) {
    const card = await buildReportCard(client, schoolId, exam.id, studentId);
    cumulativeMax += card.totalMax;
    cumulativeObtained += card.totalObtained;
    const subjects: TranscriptSubject[] = card.subjects.map((subject) => ({
      subjectName: subject.subjectName,
      maxMarks: subject.maxMarks,
      obtainedMarks: subject.marksObtained,
      isAbsent: subject.isAbsent,
      grade: subject.grade,
    }));
    examRows.push({
      examId: card.examId,
      name: card.examName,
      examType: exam.exam_type,
      startsOn: toIsoDate(exam.starts_on) ?? '',
      endsOn: toIsoDate(exam.ends_on) ?? '',
      publishedAt: card.publishedAt ?? '',
      totalMarks: card.totalMax,
      obtainedMarks: card.totalObtained,
      percentage: card.percentage,
      grade: card.overallGrade,
      result: card.result,
      subjects,
    });
  }

  const percentage = cumulativeMax > 0 ? (cumulativeObtained / cumulativeMax) * 100 : null;

  return {
    studentId: studentRow.id,
    studentName: fullName(studentRow.first_name, studentRow.middle_name, studentRow.last_name),
    admissionNumber: studentRow.admission_number,
    className: studentRow.class_name,
    sectionName: studentRow.section_name,
    academicYearName: yearRow.name,
    exams: examRows,
    cumulative: {
      totalMarks: cumulativeMax,
      obtainedMarks: cumulativeObtained,
      percentage,
      grade: null,
    },
  };
}

async function loadSchoolHeader(
  schoolId: string,
): Promise<{ name: string; code: string; address: string | null }> {
  const { rows } = await getPool().query<{ name: string; code: string; address: string | null }>(
    'SELECT name, code, NULL::text AS address FROM schools WHERE id = $1',
    [schoolId],
  );
  if (!rows[0]) throw notFound('School not found');
  return rows[0];
}

function renderTranscript(
  transcript: TranscriptRecord,
  school: { name: string; code: string; address: string | null },
): string {
  const examSections = transcript.exams
    .map(
      (exam) => `
      <section>
        <h2>${escapeHtml(exam.name)} <span class="muted">(${escapeHtml(exam.examType)})</span></h2>
        <p class="muted">Published ${escapeHtml(exam.publishedAt.slice(0, 10))} � Result: ${escapeHtml(
          exam.result,
        )}</p>
        <table>
          <thead><tr><th>Subject</th><th class="num">Max</th><th class="num">Obtained</th><th>Grade</th></tr></thead>
          <tbody>
            ${exam.subjects
              .map(
                (subject) =>
                  `<tr><td>${escapeHtml(subject.subjectName)}${subject.isAbsent ? ' (absent)' : ''}</td><td class="num">${subject.maxMarks}</td><td class="num">${
                    subject.obtainedMarks === null ? '�' : subject.obtainedMarks
                  }</td><td>${subject.grade ? escapeHtml(subject.grade) : '�'}</td></tr>`,
              )
              .join('')}
          </tbody>
        </table>
        <p class="total">Total ${exam.obtainedMarks} / ${exam.totalMarks}${
          exam.percentage === null ? '' : ` � ${exam.percentage.toFixed(2)}%`
        }${exam.grade ? ` � Grade ${escapeHtml(exam.grade)}` : ''}</p>
      </section>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcript � ${escapeHtml(transcript.admissionNumber)}</title>
<style>
  :root { font-family: system-ui, -apple-system, Segoe UI, sans-serif; color: #0f172a; }
  body { max-width: 820px; margin: 32px auto; padding: 0 24px; }
  header { border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 4px; }
  .muted { color: #64748b; font-size: 13px; font-weight: 400; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; font-size: 14px; }
  dt { color: #64748b; }
  dd { margin: 0; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 14px; }
  th, td { border-bottom: 1px solid #e2e8f0; padding: 6px; text-align: left; }
  th { background: #f8fafc; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .total { margin-top: 8px; font-weight: 700; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(school.name)}</h1>
  <div class="muted">${escapeHtml(school.code)}${school.address ? ` � ${escapeHtml(school.address)}` : ''}</div>
</header>
<h1>Academic transcript</h1>
<dl>
  <dt>Student</dt><dd>${escapeHtml(transcript.studentName)}</dd>
  <dt>Admission no.</dt><dd>${escapeHtml(transcript.admissionNumber)}</dd>
  <dt>Class</dt><dd>${escapeHtml(
    [transcript.className, transcript.sectionName].filter(Boolean).join(' / ') || '�',
  )}</dd>
  <dt>Academic year</dt><dd>${escapeHtml(transcript.academicYearName)}</dd>
</dl>
${examSections || '<p>No published results for this academic year.</p>'}
<p class="total">Cumulative ${transcript.cumulative.obtainedMarks} / ${
    transcript.cumulative.totalMarks
  }${
    transcript.cumulative.percentage === null
      ? ''
      : ` � ${transcript.cumulative.percentage.toFixed(2)}%`
  }</p>
<p class="muted">Cumulative grade is not shown because grading bands can change between exams.</p>
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
