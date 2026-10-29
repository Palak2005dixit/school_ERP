import {
  concernAttachmentInput,
  concernCategoryInput,
  concernInput,
  concernNoteInput,
  concernUpdateInput,
  uuid,
  type Concern,
  type ConcernCategory,
  type ConcernEvent,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAnyPermission, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, notFound, parseInput } from '../lib/errors';
import { toIsoDateTime, toNumber } from '../lib/format';
import { idempotentRoute } from '../lib/idempotency';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const attachmentParams = z.object({ schoolId: uuid, id: uuid, attachmentId: uuid });
const concernQuery = z.object({
  status: z
    .enum(['open', 'in_progress', 'waiting', 'resolved', 'closed', 'cancelled'])
    .optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  assignedTo: uuid.optional(),
  categoryId: uuid.optional(),
  mine: z.enum(['true', 'false']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  search: z.string().trim().max(120).optional(),
});
const escalateInput = z.object({
  note: z.string().trim().min(1).max(4000).optional(),
});
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const STAFF_VIEW = ['concerns.manage', 'concerns.assign'];

/**
 * Generic concerns, complaints and SLA tasks.
 *
 * Safeguarding records never appear here. Staff with the manage/assign
 * permission see the whole queue and every internal note; a requester sees only
 * their own concerns and only the events and attachments explicitly marked as
 * requester-visible. Overdue is derived from the stored SLA due time.
 */
export async function registerConcernRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------- categories ----------------------------- */

  app.get(
    '/api/schools/:schoolId/concerns/categories',
    { preHandler: requirePermission('concerns.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        code: string;
        name: string;
        default_priority: ConcernCategory['defaultPriority'];
        sla_hours: number;
        active: boolean;
      }>(
        `SELECT id, code, name, default_priority, sla_hours, active
         FROM concern_categories WHERE school_id = $1 ORDER BY name`,
        [schoolId],
      );
      const items: ConcernCategory[] = rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        defaultPriority: row.default_priority,
        slaHours: row.sla_hours,
        active: row.active,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/concerns/categories',
    { preHandler: requirePermission('concerns.category.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(concernCategoryInput, request.body);
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO concern_categories
           (school_id, code, name, default_priority, sla_hours, active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [schoolId, input.code, input.name, input.defaultPriority, input.slaHours, input.active],
      );
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  app.patch(
    '/api/schools/:schoolId/concerns/categories/:id',
    { preHandler: requirePermission('concerns.category.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(concernCategoryInput.partial(), request.body);
      const { rows } = await getPool().query<{
        code: string;
        name: string;
        default_priority: ConcernCategory['defaultPriority'];
        sla_hours: number;
        active: boolean;
      }>(
        `SELECT code, name, default_priority, sla_hours, active
         FROM concern_categories WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      );
      const row = rows[0];
      if (!row) throw notFound('Category not found');
      await getPool().query(
        `UPDATE concern_categories SET
           code = $3, name = $4, default_priority = $5, sla_hours = $6, active = $7
         WHERE school_id = $1 AND id = $2`,
        [
          schoolId,
          id,
          input.code ?? row.code,
          input.name ?? row.name,
          input.defaultPriority ?? row.default_priority,
          input.slaHours ?? row.sla_hours,
          input.active ?? row.active,
        ],
      );
      return { id };
    },
  );

  /* --------------------------------- concerns ------------------------------ */

  app.get(
    '/api/schools/:schoolId/concerns',
    { preHandler: requireAnyPermission('concerns.view', 'concerns.manage') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(concernQuery, request.query);
      const actor = getActor(request);
      const staffView = STAFF_VIEW.some((permission) => actor.permissions.has(permission));
      const params: unknown[] = [schoolId];
      const filters = ['c.school_id = $1'];
      if (!staffView) {
        params.push(actor.userId);
        filters.push(`c.requester_user_id = $${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        filters.push(`c.status = $${params.length}`);
      }
      if (query.priority) {
        params.push(query.priority);
        filters.push(`c.priority = $${params.length}`);
      }
      if (query.assignedTo) {
        params.push(query.assignedTo);
        filters.push(`c.assigned_to = $${params.length}`);
      }
      if (query.categoryId) {
        params.push(query.categoryId);
        filters.push(`c.category_id = $${params.length}`);
      }
      if (query.mine === 'true') {
        params.push(actor.userId);
        filters.push(`c.assigned_to = $${params.length}`);
      }
      if (query.overdue === 'true') {
        filters.push(`c.sla_due_at < now()
          AND c.status NOT IN ('resolved', 'closed', 'cancelled')`);
      }
      if (query.search) {
        params.push(`%${query.search}%`);
        filters.push(
          `(c.subject ILIKE $${params.length} OR c.reference ILIKE $${params.length}
            OR c.requester_name ILIKE $${params.length})`,
        );
      }
      const { rows } = await getPool().query<ConcernRow>(
        `${concernSelect}
         WHERE ${filters.join(' AND ')}
         ORDER BY
           CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                           WHEN 'medium' THEN 2 ELSE 3 END,
           c.sla_due_at`,
        params,
      );
      return { items: rows.map(toConcern) };
    },
  );

  app.get(
    '/api/schools/:schoolId/concerns/:id',
    { preHandler: requireAnyPermission('concerns.view', 'concerns.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const staffView = STAFF_VIEW.some((permission) => actor.permissions.has(permission));
      const { rows } = await getPool().query<ConcernRow>(
        `${concernSelect} WHERE c.school_id = $1 AND c.id = $2`,
        [schoolId, id],
      );
      const row = rows[0];
      if (!row) throw notFound('Concern not found');
      if (!staffView && row.requester_user_id !== actor.userId) {
        throw notFound('Concern not found');
      }
      const events = await getPool().query<{
        id: string;
        event_type: ConcernEvent['eventType'];
        actor_name: string | null;
        note: string | null;
        is_internal: boolean;
        from_status: string | null;
        to_status: string | null;
        created_at: Date;
      }>(
        `SELECT e.id, e.event_type, u.display_name AS actor_name, e.note, e.is_internal,
                e.from_status, e.to_status, e.created_at
         FROM concern_events e
         LEFT JOIN users u ON u.id = e.actor_user_id
         WHERE e.school_id = $1 AND e.concern_id = $2
           ${staffView ? '' : 'AND e.is_internal = FALSE'}
         ORDER BY e.created_at`,
        [schoolId, id],
      );
      const attachments = await getPool().query<{
        id: string;
        filename: string;
        content_type: string;
        byte_size: number;
        is_internal: boolean;
        created_at: Date;
      }>(
        `SELECT id, filename, content_type, byte_size, is_internal, created_at
         FROM concern_attachments
         WHERE school_id = $1 AND concern_id = $2
           ${staffView ? '' : 'AND is_internal = FALSE'}
         ORDER BY created_at`,
        [schoolId, id],
      );
      return {
        ...toConcern(row),
        events: events.rows.map((event) => ({
          id: event.id,
          eventType: event.event_type,
          actorName: event.actor_name,
          note: event.note,
          isInternal: event.is_internal,
          fromStatus: event.from_status,
          toStatus: event.to_status,
          createdAt: toIsoDateTime(event.created_at),
        })),
        attachments: attachments.rows.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          contentType: attachment.content_type,
          byteSize: attachment.byte_size,
          isInternal: attachment.is_internal,
          createdAt: toIsoDateTime(attachment.created_at),
        })),
      };
    },
  );

  app.post(
    '/api/schools/:schoolId/concerns',
    { preHandler: requireAnyPermission('concerns.view', 'concerns.manage') },
    idempotentRoute('POST /concerns', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(concernInput, request.body);
      const actor = getActor(request);
      const staffView = STAFF_VIEW.some((permission) => actor.permissions.has(permission));
      const created = await withTransaction(async (client) => {
        let priority = input.priority ?? 'medium';
        let slaHours = 24;
        let categoryId: string | null = null;
        if (input.categoryId) {
          const category = await client.query<{
            default_priority: ConcernCategory['defaultPriority'];
            sla_hours: number;
            active: boolean;
          }>(
            `SELECT default_priority, sla_hours, active FROM concern_categories
             WHERE school_id = $1 AND id = $2`,
            [schoolId, input.categoryId],
          );
          const row = category.rows[0];
          if (!row || !row.active) throw notFound('Active category not found');
          categoryId = input.categoryId;
          priority = input.priority ?? row.default_priority;
          slaHours = row.sla_hours;
        }
        if (input.studentId) {
          const student = await client.query(
            'SELECT 1 FROM students WHERE school_id = $1 AND id = $2',
            [schoolId, input.studentId],
          );
          if (student.rowCount === 0) throw notFound('Student not found');
        }
        const reference = await nextReference(client, schoolId);
        const { rows } = await client.query<{ id: string; sla_due_at: Date }>(
          `INSERT INTO concerns
             (school_id, reference, category_id, subject, description, requester_user_id,
              requester_name, requester_email, student_id, priority, visibility, sla_due_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   now() + ($12::int * interval '1 hour'))
           RETURNING id, sla_due_at`,
          [
            schoolId,
            reference,
            categoryId,
            input.subject,
            input.description,
            actor.userId,
            input.requesterName ?? actor.displayName,
            input.requesterEmail ?? actor.email,
            input.studentId ?? null,
            priority,
            staffView ? input.visibility : 'requester',
            slaHours,
          ],
        );
        const concernId = rows[0]!.id;
        await client.query(
          `INSERT INTO concern_events
             (school_id, concern_id, event_type, actor_user_id, note, is_internal, to_status)
           VALUES ($1, $2, 'created', $3, $4, $5, 'open')`,
          [
            schoolId,
            concernId,
            actor.userId,
            staffView && input.visibility === 'internal' ? 'Concern recorded' : null,
            staffView && input.visibility === 'internal',
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'concerns.created',
          entityType: 'concern',
          entityId: concernId,
          outcome: 'success',
          after: { reference, priority, categoryId },
          ...requestMeta(request),
        });
        return {
          id: concernId,
          reference,
          priority,
          slaDueAt: toIsoDateTime(rows[0]!.sla_due_at),
        };
      });
      return reply.status(201).send(created);
    }),
  );

  app.patch(
    '/api/schools/:schoolId/concerns/:id',
    { preHandler: requirePermission('concerns.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(concernUpdateInput, request.body);
      const actor = getActor(request);
      const result = await withTransaction(async (client) => {
        const found = await client.query<{
          priority: Concern['priority'];
          status: Concern['status'];
          visibility: Concern['visibility'];
          assigned_to: string | null;
          resolution_summary: string | null;
          first_response_at: Date | null;
          requester_user_id: string;
          reference: string;
        }>(
          `SELECT priority, status, visibility, assigned_to, resolution_summary,
                  first_response_at, requester_user_id, reference
           FROM concerns WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = found.rows[0];
        if (!row) throw notFound('Concern not found');

        if (input.assignedTo) {
          const assignee = await client.query(
            `SELECT 1 FROM user_role_assignments
             WHERE school_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
            [schoolId, input.assignedTo],
          );
          if (assignee.rowCount === 0) throw notFound('Assignee not found in this school');
        }

        const nextStatus = input.status ?? row.status;
        const nextPriority = input.priority ?? row.priority;
        const nextVisibility = input.visibility ?? row.visibility;
        const nextAssignee =
          input.assignedTo === undefined ? row.assigned_to : input.assignedTo;
        const resolvedAt =
          nextStatus === 'resolved'
            ? row.status === 'resolved'
              ? undefined
              : new Date()
            : null;
        const responded =
          input.status !== undefined || input.assignedTo !== undefined ? new Date() : undefined;

        await client.query(
          `UPDATE concerns SET
             priority = $3, status = $4, visibility = $5, assigned_to = $6,
             resolution_summary = $7,
             resolved_at = CASE WHEN $4 = 'resolved'
                                THEN COALESCE($8::timestamptz, resolved_at)
                                ELSE NULL END,
             first_response_at = COALESCE(first_response_at, $9::timestamptz),
             row_version = row_version + 1
           WHERE school_id = $1 AND id = $2`,
          [
            schoolId,
            id,
            nextPriority,
            nextStatus,
            nextVisibility,
            nextAssignee,
            input.resolutionSummary === undefined
              ? row.resolution_summary
              : input.resolutionSummary,
            resolvedAt ?? null,
            responded ?? null,
          ],
        );

        if (nextAssignee !== row.assigned_to) {
          await client.query(
            `INSERT INTO concern_events
               (school_id, concern_id, event_type, actor_user_id, is_internal)
             VALUES ($1, $2, 'assigned', $3, FALSE)`,
            [schoolId, id, actor.userId],
          );
        }
        if (nextStatus !== row.status) {
          await client.query(
            `INSERT INTO concern_events
               (school_id, concern_id, event_type, actor_user_id, note, is_internal,
                from_status, to_status)
             VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7)`,
            [
              schoolId,
              id,
              nextStatus === 'resolved'
                ? 'resolved'
                : row.status === 'resolved' || row.status === 'closed'
                  ? 'reopened'
                  : 'status_changed',
              actor.userId,
              input.resolutionSummary ?? null,
              row.status,
              nextStatus,
            ],
          );
        }
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'concerns.updated',
          entityType: 'concern',
          entityId: id,
          outcome: 'success',
          before: { status: row.status, priority: row.priority, assignedTo: row.assigned_to },
          after: {
            status: nextStatus,
            priority: nextPriority,
            assignedTo: nextAssignee,
            visibility: nextVisibility,
          },
          ...requestMeta(request),
        });
        return { id, status: nextStatus, priority: nextPriority };
      });
      return result;
    },
  );

  app.post(
    '/api/schools/:schoolId/concerns/:id/escalate',
    { preHandler: requirePermission('concerns.assign') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(escalateInput, request.body ?? {});
      const actor = getActor(request);
      const result = await withTransaction(async (client) => {
        const found = await client.query<{ priority: Concern['priority']; status: Concern['status'] }>(
          `SELECT priority, status FROM concerns
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = found.rows[0];
        if (!row) throw notFound('Concern not found');
        if (['resolved', 'closed', 'cancelled'].includes(row.status)) {
          throw badRequest('A finished concern cannot be escalated');
        }
        const higher =
          row.priority === 'low' ? 'medium' : row.priority === 'medium' ? 'high' : 'urgent';
        const priority = row.priority === 'urgent' ? 'urgent' : higher;
        await client.query(
          `UPDATE concerns SET priority = $3, first_response_at = COALESCE(first_response_at, now()),
             row_version = row_version + 1
           WHERE school_id = $1 AND id = $2`,
          [schoolId, id, priority],
        );
        await client.query(
          `INSERT INTO concern_events
             (school_id, concern_id, event_type, actor_user_id, note, is_internal)
           VALUES ($1, $2, 'escalated', $3, $4, FALSE)`,
          [schoolId, id, actor.userId, input.note ?? null],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'concerns.escalated',
          entityType: 'concern',
          entityId: id,
          outcome: 'success',
          before: { priority: row.priority },
          after: { priority },
          ...requestMeta(request),
        });
        return { id, priority };
      });
      return result;
    },
  );

  app.post(
    '/api/schools/:schoolId/concerns/:id/notes',
    { preHandler: requireAnyPermission('concerns.view', 'concerns.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(concernNoteInput, request.body);
      const actor = getActor(request);
      const staffView = STAFF_VIEW.some((permission) => actor.permissions.has(permission));
      const concern = await getPool().query<{ requester_user_id: string }>(
        'SELECT requester_user_id FROM concerns WHERE school_id = $1 AND id = $2',
        [schoolId, id],
      );
      const row = concern.rows[0];
      if (!row) throw notFound('Concern not found');
      if (!staffView && row.requester_user_id !== actor.userId) {
        throw notFound('Concern not found');
      }
      const internal = staffView ? input.isInternal : false;
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO concern_events
           (school_id, concern_id, event_type, actor_user_id, note, is_internal)
         VALUES ($1, $2, 'note_added', $3, $4, $5) RETURNING id`,
        [schoolId, id, actor.userId, input.note, internal],
      );
      await getPool().query(
        `UPDATE concerns SET first_response_at = COALESCE(first_response_at, now()),
           row_version = row_version + 1
         WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      );
      return reply.status(201).send({ id: rows[0]!.id, isInternal: internal });
    },
  );

  /* -------------------------------- attachments ---------------------------- */

  app.post(
    '/api/schools/:schoolId/concerns/:id/attachments',
    { preHandler: requireAnyPermission('concerns.view', 'concerns.manage'), bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(concernAttachmentInput, request.body);
      const actor = getActor(request);
      const staffView = STAFF_VIEW.some((permission) => actor.permissions.has(permission));
      const concern = await getPool().query<{ requester_user_id: string }>(
        'SELECT requester_user_id FROM concerns WHERE school_id = $1 AND id = $2',
        [schoolId, id],
      );
      const row = concern.rows[0];
      if (!row) throw notFound('Concern not found');
      if (!staffView && row.requester_user_id !== actor.userId) {
        throw notFound('Concern not found');
      }
      const buffer = decodeAttachment(input.dataBase64);
      const internal = staffView ? input.isInternal : false;
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO concern_attachments
           (school_id, concern_id, filename, content_type, byte_size, data, uploaded_by,
            is_internal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          schoolId,
          id,
          input.filename,
          input.contentType,
          buffer.length,
          buffer,
          actor.userId,
          internal,
        ],
      );
      await getPool().query(
        `INSERT INTO concern_events
           (school_id, concern_id, event_type, actor_user_id, is_internal)
         VALUES ($1, $2, 'attachment_added', $3, $4)`,
        [schoolId, id, actor.userId, internal],
      );
      return reply.status(201).send({ id: rows[0]!.id, byteSize: buffer.length });
    },
  );

  app.get(
    '/api/schools/:schoolId/concerns/:id/attachments/:attachmentId/download',
    { preHandler: requireAnyPermission('concerns.view', 'concerns.manage') },
    async (request, reply) => {
      const { schoolId, id, attachmentId } = parseInput(attachmentParams, request.params);
      const actor = getActor(request);
      const staffView = STAFF_VIEW.some((permission) => actor.permissions.has(permission));
      const { rows } = await getPool().query<{
        filename: string;
        content_type: string;
        data: Buffer;
        is_internal: boolean;
        requester_user_id: string;
      }>(
        `SELECT a.filename, a.content_type, a.data, a.is_internal, c.requester_user_id
         FROM concern_attachments a
         JOIN concerns c ON c.id = a.concern_id AND c.school_id = a.school_id
         WHERE a.school_id = $1 AND a.concern_id = $2 AND a.id = $3`,
        [schoolId, id, attachmentId],
      );
      const row = rows[0];
      if (!row) throw notFound('Attachment not found');
      if (!staffView) {
        if (row.requester_user_id !== actor.userId || row.is_internal) {
          throw notFound('Attachment not found');
        }
      }
      return reply
        .header('Content-Type', row.content_type)
        .header('Content-Disposition', `attachment; filename="${safeFilename(row.filename)}"`)
        .send(row.data);
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

interface ConcernRow {
  id: string;
  reference: string;
  category_id: string | null;
  category_name: string | null;
  subject: string;
  description: string;
  requester_user_id: string;
  requester_name: string;
  requester_email: string | null;
  student_id: string | null;
  student_name: string | null;
  assigned_to: string | null;
  assignee_name: string | null;
  priority: Concern['priority'];
  status: Concern['status'];
  visibility: Concern['visibility'];
  sla_due_at: Date;
  first_response_at: Date | null;
  resolved_at: Date | null;
  resolution_summary: string | null;
  created_at: Date;
}

const concernSelect = `
  SELECT c.id, c.reference, c.category_id, cat.name AS category_name, c.subject,
         c.description, c.requester_user_id, c.requester_name, c.requester_email,
         c.student_id,
         concat_ws(' ', s.first_name, s.middle_name, s.last_name) AS student_name,
         c.assigned_to, u.display_name AS assignee_name, c.priority, c.status,
         c.visibility, c.sla_due_at, c.first_response_at, c.resolved_at,
         c.resolution_summary, c.created_at
  FROM concerns c
  LEFT JOIN concern_categories cat ON cat.id = c.category_id AND cat.school_id = c.school_id
  LEFT JOIN students s ON s.id = c.student_id AND s.school_id = c.school_id
  LEFT JOIN users u ON u.id = c.assigned_to`;

function toConcern(row: ConcernRow): Concern {
  return {
    id: row.id,
    reference: row.reference,
    categoryId: row.category_id,
    categoryName: row.category_name,
    subject: row.subject,
    description: row.description,
    requesterUserId: row.requester_user_id,
    requesterName: row.requester_name,
    requesterEmail: row.requester_email,
    studentId: row.student_id,
    studentName: row.student_name,
    assignedTo: row.assigned_to,
    assigneeName: row.assignee_name,
    priority: row.priority,
    status: row.status,
    visibility: row.visibility,
    slaDueAt: toIsoDateTime(row.sla_due_at),
    overdue:
      row.sla_due_at.getTime() < Date.now() &&
      !['resolved', 'closed', 'cancelled'].includes(row.status),
    firstResponseAt: row.first_response_at ? toIsoDateTime(row.first_response_at) : null,
    resolvedAt: row.resolved_at ? toIsoDateTime(row.resolved_at) : null,
    resolutionSummary: row.resolution_summary,
    createdAt: toIsoDateTime(row.created_at),
  };
}

async function nextReference(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<{ count: string }> }> },
  schoolId: string,
): Promise<string> {
  const { rows } = await client.query(
    'SELECT count(*)::text AS count FROM concerns WHERE school_id = $1',
    [schoolId],
  );
  const sequence = toNumber(rows[0]?.count) + 1;
  const year = new Date().getUTCFullYear();
  return `CN-${year}-${String(sequence).padStart(6, '0')}`;
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

function safeFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '_').slice(0, 255);
}
