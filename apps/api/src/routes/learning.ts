import {
  homeworkInput,
  homeworkReviewInput,
  homeworkStatusInput,
  homeworkSubmissionInput,
  learningAttachmentInput,
  learningResourceInput,
  learningResourceUpdate,
  questionBankInput,
  uuid,
  type HomeworkAssignment,
  type HomeworkSubmission,
  type LearningResource,
  type QuestionBankItem,
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
import { assertGuardianLinked } from '../lib/portal';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const resourceQuery = z.object({
  status: z.enum(['draft', 'published', 'archived']).optional(),
  classId: uuid.optional(),
  subjectId: uuid.optional(),
  resourceType: z
    .enum(['document', 'link', 'video', 'audio', 'image', 'other'])
    .optional(),
});
const homeworkQuery = z.object({
  status: z.enum(['draft', 'published', 'closed']).optional(),
  sectionId: uuid.optional(),
  subjectId: uuid.optional(),
});
const submissionQuery = z.object({ studentId: uuid.optional() });
const questionQuery = z.object({
  subjectId: uuid.optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
});
const MAX_ATTACHMENT_BYTES = 1024 * 1024;

/**
 * Learning resources, homework and the question bank.
 *
 * Draft and archived resources are only visible to staff who can manage the
 * module. Homework and submissions for families are scoped to the sections of
 * students they are a verified guardian of, never to a client-supplied filter.
 * Submission files share the notice attachment size cap.
 */
export async function registerLearningRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------- resources ------------------------------ */

  app.get(
    '/api/schools/:schoolId/learning/resources',
    { preHandler: requirePermission('learning.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(resourceQuery, request.query);
      const actor = getActor(request);
      const staffView =
        actor.permissions.has('learning.manage') || actor.permissions.has('learning.grade');
      const params: unknown[] = [schoolId];
      const filters = ['r.school_id = $1'];
      if (query.status) {
        params.push(query.status);
        filters.push(`r.status = $${params.length}`);
      } else if (!staffView) {
        filters.push(`r.status = 'published'`);
      }
      if (!staffView) filters.push(`r.visibility <> 'staff'`);
      if (query.classId) {
        params.push(query.classId);
        filters.push(`r.class_id = $${params.length}`);
      }
      if (query.subjectId) {
        params.push(query.subjectId);
        filters.push(`r.subject_id = $${params.length}`);
      }
      if (query.resourceType) {
        params.push(query.resourceType);
        filters.push(`r.resource_type = $${params.length}`);
      }
      const { rows } = await getPool().query<{
        id: string;
        title: string;
        description: string | null;
        resource_type: LearningResource['resourceType'];
        subject_id: string | null;
        subject_name: string | null;
        class_id: string | null;
        class_name: string | null;
        url: string | null;
        visibility: LearningResource['visibility'];
        status: LearningResource['status'];
        created_by_name: string | null;
      }>(
        `SELECT r.id, r.title, r.description, r.resource_type, r.subject_id,
                s.name AS subject_name, r.class_id, c.name AS class_name, r.url,
                r.visibility, r.status, u.display_name AS created_by_name
         FROM learning_resources r
         LEFT JOIN subjects s ON s.id = r.subject_id AND s.school_id = r.school_id
         LEFT JOIN classes c ON c.id = r.class_id AND c.school_id = r.school_id
         LEFT JOIN users u ON u.id = r.created_by
         WHERE ${filters.join(' AND ')}
         ORDER BY r.updated_at DESC`,
        params,
      );
      const attachments = await getPool().query<{
        id: string;
        resource_id: string;
        filename: string;
        content_type: string;
        byte_size: number;
      }>(
        `SELECT a.id, a.resource_id, a.filename, a.content_type, a.byte_size
         FROM learning_attachments a
         JOIN learning_resources r ON r.id = a.resource_id AND r.school_id = a.school_id
         WHERE a.school_id = $1 ORDER BY a.created_at`,
        [schoolId],
      );
      const byResource = new Map<
        string,
        Array<{ id: string; filename: string; contentType: string; byteSize: number }>
      >();
      for (const attachment of attachments.rows) {
        const list = byResource.get(attachment.resource_id) ?? [];
        list.push({
          id: attachment.id,
          filename: attachment.filename,
          contentType: attachment.content_type,
          byteSize: attachment.byte_size,
        });
        byResource.set(attachment.resource_id, list);
      }
      const items: LearningResource[] = rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        resourceType: row.resource_type,
        subjectId: row.subject_id,
        subjectName: row.subject_name,
        classId: row.class_id,
        className: row.class_name,
        url: row.url,
        visibility: row.visibility,
        status: row.status,
        createdByName: row.created_by_name,
        attachments: byResource.get(row.id) ?? [],
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/learning/resources',
    { preHandler: requirePermission('learning.manage') },
    idempotentRoute('POST /learning/resources', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(learningResourceInput, request.body);
      const actor = getActor(request);
      await assertLearningRefs(getPool(), schoolId, input.subjectId ?? null, input.classId ?? null);
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO learning_resources
           (school_id, title, description, resource_type, subject_id, class_id, url,
            visibility, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          schoolId,
          input.title,
          input.description ?? null,
          input.resourceType,
          input.subjectId ?? null,
          input.classId ?? null,
          input.url ?? null,
          input.visibility,
          input.status,
          actor.userId,
        ],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'learning.resource_created',
        entityType: 'learning_resource',
        entityId: rows[0]!.id,
        outcome: 'success',
        after: { title: input.title, status: input.status, visibility: input.visibility },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id });
    }),
  );

  app.patch(
    '/api/schools/:schoolId/learning/resources/:id',
    { preHandler: requirePermission('learning.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(learningResourceUpdate, request.body);
      const actor = getActor(request);
      const { rows } = await getPool().query<{
        title: string;
        description: string | null;
        resource_type: LearningResource['resourceType'];
        subject_id: string | null;
        class_id: string | null;
        url: string | null;
        visibility: LearningResource['visibility'];
        status: LearningResource['status'];
      }>(
        `SELECT title, description, resource_type, subject_id, class_id, url, visibility, status
         FROM learning_resources WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      );
      const row = rows[0];
      if (!row) throw notFound('Resource not found');
      if (input.subjectId !== undefined || input.classId !== undefined) {
        await assertLearningRefs(
          getPool(),
          schoolId,
          input.subjectId === undefined ? row.subject_id : input.subjectId,
          input.classId === undefined ? row.class_id : input.classId,
        );
      }
      await getPool().query(
        `UPDATE learning_resources SET
           title = $3, description = $4, resource_type = $5, subject_id = $6,
           class_id = $7, url = $8, visibility = $9, status = $10
         WHERE school_id = $1 AND id = $2`,
        [
          schoolId,
          id,
          input.title ?? row.title,
          input.description === undefined ? row.description : input.description,
          input.resourceType ?? row.resource_type,
          input.subjectId === undefined ? row.subject_id : input.subjectId,
          input.classId === undefined ? row.class_id : input.classId,
          input.url === undefined ? row.url : input.url,
          input.visibility ?? row.visibility,
          input.status ?? row.status,
        ],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'learning.resource_updated',
        entityType: 'learning_resource',
        entityId: id,
        outcome: 'success',
        after: { title: input.title ?? row.title, status: input.status ?? row.status },
        ...requestMeta(request),
      });
      return { id };
    },
  );

  /* ------------------------------- attachments ----------------------------- */

  app.post(
    '/api/schools/:schoolId/learning/resources/:id/attachments',
    { preHandler: requirePermission('learning.manage'), bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(learningAttachmentInput, request.body);
      const actor = getActor(request);
      const resource = await getPool().query(
        'SELECT 1 FROM learning_resources WHERE school_id = $1 AND id = $2',
        [schoolId, id],
      );
      if (resource.rowCount === 0) throw notFound('Resource not found');
      const buffer = decodeAttachment(input.dataBase64);
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO learning_attachments
           (school_id, resource_id, filename, content_type, byte_size, data, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [schoolId, id, input.filename, input.contentType, buffer.length, buffer, actor.userId],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'learning.attachment_added',
        entityType: 'learning_resource',
        entityId: id,
        outcome: 'success',
        after: { filename: input.filename, byteSize: buffer.length },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id, byteSize: buffer.length });
    },
  );

  app.get(
    '/api/schools/:schoolId/learning/attachments/:attachmentId/download',
    { preHandler: requirePermission('learning.view') },
    async (request, reply) => {
      const { schoolId, attachmentId } = parseInput(
        z.object({ schoolId: uuid, attachmentId: uuid }),
        request.params,
      );
      const actor = getActor(request);
      const staffView =
        actor.permissions.has('learning.manage') || actor.permissions.has('learning.grade');
      const { rows } = await getPool().query<{
        filename: string;
        content_type: string;
        data: Buffer;
        status: LearningResource['status'];
        visibility: LearningResource['visibility'];
      }>(
        `SELECT a.filename, a.content_type, a.data, r.status, r.visibility
         FROM learning_attachments a
         JOIN learning_resources r ON r.id = a.resource_id AND r.school_id = a.school_id
         WHERE a.school_id = $1 AND a.id = $2`,
        [schoolId, attachmentId],
      );
      const row = rows[0];
      if (!row) throw notFound('Attachment not found');
      if (!staffView && (row.status !== 'published' || row.visibility === 'staff')) {
        throw notFound('Attachment not found');
      }
      return reply
        .header('Content-Type', row.content_type)
        .header('Content-Disposition', `attachment; filename="${safeFilename(row.filename)}"`)
        .send(row.data);
    },
  );

  app.delete(
    '/api/schools/:schoolId/learning/attachments/:attachmentId',
    { preHandler: requirePermission('learning.manage') },
    async (request, reply) => {
      const { schoolId, attachmentId } = parseInput(
        z.object({ schoolId: uuid, attachmentId: uuid }),
        request.params,
      );
      const actor = getActor(request);
      const { rowCount } = await getPool().query(
        'DELETE FROM learning_attachments WHERE school_id = $1 AND id = $2',
        [schoolId, attachmentId],
      );
      if (rowCount === 0) throw notFound('Attachment not found');
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'learning.attachment_deleted',
        entityType: 'learning_attachment',
        entityId: attachmentId,
        outcome: 'success',
        ...requestMeta(request),
      });
      return reply.status(204).send();
    },
  );

  /* --------------------------------- homework ------------------------------ */

  app.get(
    '/api/schools/:schoolId/learning/homework',
    { preHandler: requirePermission('learning.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(homeworkQuery, request.query);
      const actor = getActor(request);
      const staffView =
        actor.permissions.has('learning.manage') || actor.permissions.has('learning.grade');
      const params: unknown[] = [schoolId, actor.userId];
      const filters = ['h.school_id = $1'];
      if (query.status) {
        params.push(query.status);
        filters.push(`h.status = $${params.length}`);
      } else if (!staffView) {
        filters.push(`h.status = 'published'`);
      }
      if (!staffView) {
        filters.push(`EXISTS (
          SELECT 1 FROM enrollments e
          JOIN student_guardians sg
            ON sg.school_id = e.school_id AND sg.student_id = e.student_id
          JOIN guardians g ON g.id = sg.guardian_id AND g.school_id = sg.school_id
          WHERE e.school_id = h.school_id AND e.section_id = h.section_id
            AND e.academic_year_id = h.academic_year_id
            AND e.enrollment_status = 'active'
            AND g.user_id = $2 AND sg.portal_access_status = 'verified'
            AND sg.valid_to IS NULL
        )`);
      }
      if (query.sectionId) {
        params.push(query.sectionId);
        filters.push(`h.section_id = $${params.length}`);
      }
      if (query.subjectId) {
        params.push(query.subjectId);
        filters.push(`h.subject_id = $${params.length}`);
      }
      const { rows } = await getPool().query<{
        id: string;
        academic_year_id: string;
        section_id: string;
        section_name: string;
        class_name: string;
        subject_id: string;
        subject_name: string;
        title: string;
        instructions: string;
        available_from: string | null;
        due_at: Date;
        max_marks: string | null;
        allow_resubmission: boolean;
        status: HomeworkAssignment['status'];
        published_at: Date | null;
        submission_count: string;
        graded_count: string;
      }>(
        `SELECT h.id, h.academic_year_id, h.section_id, sec.name AS section_name,
                c.name AS class_name, h.subject_id, sub.name AS subject_name, h.title,
                h.instructions, h.available_from, h.due_at, h.max_marks,
                h.allow_resubmission, h.status, h.published_at,
                (SELECT count(*) FROM homework_submissions hs
                 WHERE hs.school_id = h.school_id AND hs.assignment_id = h.id)::text
                  AS submission_count,
                (SELECT count(*) FROM homework_submissions hs
                 WHERE hs.school_id = h.school_id AND hs.assignment_id = h.id
                   AND hs.status = 'reviewed')::text AS graded_count
         FROM homework_assignments h
         JOIN sections sec ON sec.id = h.section_id AND sec.school_id = h.school_id
         JOIN classes c ON c.id = sec.class_id AND c.school_id = sec.school_id
         JOIN subjects sub ON sub.id = h.subject_id AND sub.school_id = h.school_id
         WHERE ${filters.join(' AND ')}
         ORDER BY h.due_at DESC`,
        params,
      );
      const items: HomeworkAssignment[] = rows.map((row) => ({
        id: row.id,
        academicYearId: row.academic_year_id,
        sectionId: row.section_id,
        sectionName: row.section_name,
        className: row.class_name,
        subjectId: row.subject_id,
        subjectName: row.subject_name,
        title: row.title,
        instructions: row.instructions,
        availableFrom: row.available_from ? toIsoDate(row.available_from) : null,
        dueAt: toIsoDateTime(row.due_at),
        maxMarks: row.max_marks === null ? null : toNumber(row.max_marks),
        allowResubmission: row.allow_resubmission,
        status: row.status,
        publishedAt: row.published_at ? toIsoDateTime(row.published_at) : null,
        submissionCount: toNumber(row.submission_count),
        gradedCount: toNumber(row.graded_count),
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/learning/homework',
    { preHandler: requirePermission('learning.manage') },
    idempotentRoute('POST /learning/homework', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(homeworkInput, request.body);
      const actor = getActor(request);
      await assertHomeworkRefs(
        getPool(),
        schoolId,
        input.academicYearId,
        input.sectionId,
        input.subjectId,
      );
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO homework_assignments
           (school_id, academic_year_id, section_id, subject_id, title, instructions,
            available_from, due_at, max_marks, allow_resubmission, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          schoolId,
          input.academicYearId,
          input.sectionId,
          input.subjectId,
          input.title,
          input.instructions,
          input.availableFrom ?? null,
          input.dueAt,
          input.maxMarks ?? null,
          input.allowResubmission,
          actor.userId,
        ],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'learning.homework_created',
        entityType: 'homework_assignment',
        entityId: rows[0]!.id,
        outcome: 'success',
        after: { title: input.title, dueAt: input.dueAt, sectionId: input.sectionId },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id });
    }),
  );

  app.patch(
    '/api/schools/:schoolId/learning/homework/:id/status',
    { preHandler: requirePermission('learning.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(homeworkStatusInput, request.body);
      const actor = getActor(request);
      const { rows } = await getPool().query<{ id: string }>(
        `UPDATE homework_assignments SET
           status = $3,
           published_at = CASE WHEN $3 = 'published' THEN COALESCE(published_at, now())
                               ELSE published_at END
         WHERE school_id = $1 AND id = $2 RETURNING id`,
        [schoolId, id, input.status],
      );
      if (!rows[0]) throw notFound('Homework not found');
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'learning.homework_status_changed',
        entityType: 'homework_assignment',
        entityId: id,
        outcome: 'success',
        after: { status: input.status },
        ...requestMeta(request),
      });
      return { id, status: input.status };
    },
  );

  app.get(
    '/api/schools/:schoolId/learning/homework/:id/submissions',
    { preHandler: requirePermission('learning.view') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const query = parseInput(submissionQuery, request.query);
      const actor = getActor(request);
      const grader =
        actor.permissions.has('learning.grade') || actor.permissions.has('learning.manage');
      const params: unknown[] = [schoolId, id];
      const filters = ['hs.school_id = $1', 'hs.assignment_id = $2'];
      if (query.studentId) {
        params.push(query.studentId);
        filters.push(`hs.student_id = $${params.length}`);
      }
      if (!grader) {
        params.push(actor.userId);
        filters.push(`EXISTS (
          SELECT 1 FROM student_guardians sg
          JOIN guardians g ON g.id = sg.guardian_id AND g.school_id = sg.school_id
          WHERE sg.school_id = hs.school_id AND sg.student_id = hs.student_id
            AND g.user_id = $${params.length} AND sg.portal_access_status = 'verified'
            AND sg.valid_to IS NULL
        )`);
      }
      const { rows } = await getPool().query<{
        id: string;
        assignment_id: string;
        student_id: string;
        student_name: string;
        attempt: number;
        submitted_at: Date;
        status: HomeworkSubmission['status'];
        content: string | null;
        attachment_name: string | null;
        attachment_type: string | null;
        attachment_size: number | null;
        marks: string | null;
        feedback: string | null;
        reviewed_by_name: string | null;
        reviewed_at: Date | null;
      }>(
        `SELECT hs.id, hs.assignment_id, hs.student_id,
                concat_ws(' ', s.first_name, s.middle_name, s.last_name) AS student_name,
                hs.attempt, hs.submitted_at, hs.status, hs.content, hs.attachment_name,
                hs.attachment_type, hs.attachment_size, hs.marks, hs.feedback,
                u.display_name AS reviewed_by_name, hs.reviewed_at
         FROM homework_submissions hs
         JOIN students s ON s.id = hs.student_id AND s.school_id = hs.school_id
         LEFT JOIN users u ON u.id = hs.reviewed_by
         WHERE ${filters.join(' AND ')}
         ORDER BY s.first_name, hs.attempt DESC`,
        params,
      );
      const items: HomeworkSubmission[] = rows.map((row) => ({
        id: row.id,
        assignmentId: row.assignment_id,
        studentId: row.student_id,
        studentName: row.student_name,
        attempt: row.attempt,
        submittedAt: toIsoDateTime(row.submitted_at),
        status: row.status,
        content: row.content,
        attachmentName: row.attachment_name,
        attachmentType: row.attachment_type,
        attachmentSize: row.attachment_size,
        marks: row.marks === null ? null : toNumber(row.marks),
        feedback: row.feedback,
        reviewedByName: row.reviewed_by_name,
        reviewedAt: row.reviewed_at ? toIsoDateTime(row.reviewed_at) : null,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/learning/homework/:id/submissions',
    { preHandler: requirePermission('learning.submit'), bodyLimit: 2 * 1024 * 1024 },
    idempotentRoute('POST /learning/homework/submissions', async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(homeworkSubmissionInput, request.body);
      const actor = getActor(request);
      const manager =
        actor.permissions.has('learning.manage') || actor.permissions.has('learning.grade');
      if (!manager) {
        await assertGuardianLinked(getPool(), schoolId, actor.userId, input.studentId);
      }
      const created = await withTransaction(async (client) => {
        const assignment = await client.query<{
          status: HomeworkAssignment['status'];
          due_at: Date;
          allow_resubmission: boolean;
          section_id: string;
          academic_year_id: string;
        }>(
          `SELECT status, due_at, allow_resubmission, section_id, academic_year_id
           FROM homework_assignments WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const homework = assignment.rows[0];
        if (!homework) throw notFound('Homework not found');
        if (homework.status !== 'published') {
          throw conflict('This homework is not open for submissions');
        }

        const enrollment = await client.query(
          `SELECT 1 FROM enrollments
           WHERE school_id = $1 AND student_id = $2 AND section_id = $3
             AND academic_year_id = $4 AND enrollment_status = 'active'`,
          [schoolId, input.studentId, homework.section_id, homework.academic_year_id],
        );
        if (enrollment.rowCount === 0) {
          throw notFound('Student is not enrolled in this homework section');
        }

        const attempts = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM homework_submissions
           WHERE school_id = $1 AND assignment_id = $2 AND student_id = $3`,
          [schoolId, id, input.studentId],
        );
        const previous = toNumber(attempts.rows[0]?.count);
        if (previous > 0 && !homework.allow_resubmission) {
          throw conflict('This homework already has a submission and resubmission is not allowed');
        }
        if (previous >= 10) throw conflict('This homework has reached its attempt limit');

        const attachment = buildSubmissionAttachment(input);
        const late = Date.now() > new Date(homework.due_at).getTime();
        const { rows } = await client.query<{ id: string; attempt: number }>(
          `INSERT INTO homework_submissions
             (school_id, assignment_id, student_id, attempt, status, content,
              attachment_name, attachment_type, attachment_size, attachment_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, attempt`,
          [
            schoolId,
            id,
            input.studentId,
            previous + 1,
            late ? 'late' : 'submitted',
            input.content ?? null,
            attachment?.name ?? null,
            attachment?.type ?? null,
            attachment?.size ?? null,
            attachment?.data ?? null,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'learning.submission_created',
          entityType: 'homework_submission',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: {
            assignmentId: id,
            studentId: input.studentId,
            attempt: rows[0]!.attempt,
            late,
          },
          ...requestMeta(request),
        });
        return { id: rows[0]!.id, attempt: rows[0]!.attempt, status: late ? 'late' : 'submitted' };
      });
      return reply.status(201).send(created);
    }),
  );

  app.patch(
    '/api/schools/:schoolId/learning/submissions/:id/review',
    { preHandler: requirePermission('learning.grade') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(homeworkReviewInput, request.body);
      const actor = getActor(request);
      const { rows } = await getPool().query<{
        assignment_id: string;
        student_id: string;
        attempt: number;
        max_marks: string | null;
      }>(
        `SELECT hs.assignment_id, hs.student_id, hs.attempt, h.max_marks
         FROM homework_submissions hs
         JOIN homework_assignments h ON h.id = hs.assignment_id AND h.school_id = hs.school_id
         WHERE hs.school_id = $1 AND hs.id = $2`,
        [schoolId, id],
      );
      const row = rows[0];
      if (!row) throw notFound('Submission not found');
      if (row.max_marks !== null && input.marks !== undefined && input.marks !== null) {
        if (input.marks > toNumber(row.max_marks)) {
          throw badRequest('Marks cannot exceed the homework maximum', {
            marks: [`Enter marks up to ${toNumber(row.max_marks)}`],
          });
        }
      }
      await getPool().query(
        `UPDATE homework_submissions SET
           status = $3, marks = $4, feedback = $5, reviewed_by = $6, reviewed_at = now()
         WHERE school_id = $1 AND id = $2`,
        [
          schoolId,
          id,
          input.status,
          input.marks === undefined ? null : input.marks,
          input.feedback ?? null,
          actor.userId,
        ],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'learning.submission_reviewed',
        entityType: 'homework_submission',
        entityId: id,
        outcome: 'success',
        after: { status: input.status, marks: input.marks ?? null },
        ...requestMeta(request),
      });
      return { id, status: input.status };
    },
  );

  /* ------------------------------- question bank --------------------------- */

  app.get(
    '/api/schools/:schoolId/learning/questions',
    { preHandler: requirePermission('learning.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(questionQuery, request.query);
      const params: unknown[] = [schoolId];
      const filters = ['q.school_id = $1'];
      if (query.subjectId) {
        params.push(query.subjectId);
        filters.push(`q.subject_id = $${params.length}`);
      }
      if (query.difficulty) {
        params.push(query.difficulty);
        filters.push(`q.difficulty = $${params.length}`);
      }
      const { rows } = await getPool().query<{
        id: string;
        subject_id: string;
        subject_name: string;
        topic: string | null;
        question_type: QuestionBankItem['questionType'];
        difficulty: QuestionBankItem['difficulty'];
        question_text: string;
        answer_text: string | null;
        marks: string | null;
      }>(
        `SELECT q.id, q.subject_id, s.name AS subject_name, q.topic, q.question_type,
                q.difficulty, q.question_text, q.answer_text, q.marks
         FROM question_bank_items q
         JOIN subjects s ON s.id = q.subject_id AND s.school_id = q.school_id
         WHERE ${filters.join(' AND ')}
         ORDER BY s.name, q.difficulty, q.created_at DESC`,
        params,
      );
      const items: QuestionBankItem[] = rows.map((row) => ({
        id: row.id,
        subjectId: row.subject_id,
        subjectName: row.subject_name,
        topic: row.topic,
        questionType: row.question_type,
        difficulty: row.difficulty,
        questionText: row.question_text,
        answerText: row.answer_text,
        marks: row.marks === null ? null : toNumber(row.marks),
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/learning/questions',
    { preHandler: requirePermission('learning.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(questionBankInput, request.body);
      const actor = getActor(request);
      const subject = await getPool().query(
        'SELECT 1 FROM subjects WHERE school_id = $1 AND id = $2',
        [schoolId, input.subjectId],
      );
      if (subject.rowCount === 0) throw notFound('Subject not found');
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO question_bank_items
           (school_id, subject_id, topic, question_type, difficulty, question_text,
            answer_text, marks, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          schoolId,
          input.subjectId,
          input.topic ?? null,
          input.questionType,
          input.difficulty,
          input.questionText,
          input.answerText ?? null,
          input.marks ?? null,
          actor.userId,
        ],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'learning.question_created',
        entityType: 'question_bank_item',
        entityId: rows[0]!.id,
        outcome: 'success',
        after: { subjectId: input.subjectId, difficulty: input.difficulty },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  app.delete(
    '/api/schools/:schoolId/learning/questions/:id',
    { preHandler: requirePermission('learning.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const { rowCount } = await getPool().query(
        'DELETE FROM question_bank_items WHERE school_id = $1 AND id = $2',
        [schoolId, id],
      );
      if (rowCount === 0) throw notFound('Question not found');
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'learning.question_deleted',
        entityType: 'question_bank_item',
        entityId: id,
        outcome: 'success',
        ...requestMeta(request),
      });
      return reply.status(204).send();
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

async function assertLearningRefs(
  client: Queryable,
  schoolId: string,
  subjectId: string | null,
  classId: string | null,
): Promise<void> {
  if (subjectId) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM subjects WHERE school_id = $1 AND id = $2',
      [schoolId, subjectId],
    );
    if (!rowCount) throw notFound('Subject not found');
  }
  if (classId) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM classes WHERE school_id = $1 AND id = $2',
      [schoolId, classId],
    );
    if (!rowCount) throw notFound('Class not found');
  }
}

async function assertHomeworkRefs(
  client: Queryable,
  schoolId: string,
  academicYearId: string,
  sectionId: string,
  subjectId: string,
): Promise<void> {
  const section = await client.query(
    `SELECT 1 FROM sections
     WHERE school_id = $1 AND id = $2 AND academic_year_id = $3`,
    [schoolId, sectionId, academicYearId],
  );
  if (section.rowCount === 0) throw notFound('Section not found in this academic year');
  const subject = await client.query(
    'SELECT 1 FROM subjects WHERE school_id = $1 AND id = $2',
    [schoolId, subjectId],
  );
  if (subject.rowCount === 0) throw notFound('Subject not found');
}

function decodeAttachment(dataBase64: string): Buffer {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch {
    throw badRequest('The file could not be decoded');
  }
  if (buffer.length === 0) throw badRequest('The file is empty');
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw badRequest('Attachments must be 1 MB or smaller');
  }
  return buffer;
}

function buildSubmissionAttachment(input: {
  attachmentName?: string;
  attachmentType?: string;
  attachmentBase64?: string;
}): { name: string; type: string; size: number; data: Buffer } | null {
  const supplied = [input.attachmentName, input.attachmentType, input.attachmentBase64].filter(
    (value) => value !== undefined,
  );
  if (supplied.length === 0) return null;
  if (
    input.attachmentName === undefined ||
    input.attachmentType === undefined ||
    input.attachmentBase64 === undefined
  ) {
    throw badRequest('A submission file needs a name, type and content', {
      attachmentBase64: ['Upload the file again'],
    });
  }
  const data = decodeAttachment(input.attachmentBase64);
  return { name: input.attachmentName, type: input.attachmentType, size: data.length, data };
}

function safeFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '_').slice(0, 255);
}
