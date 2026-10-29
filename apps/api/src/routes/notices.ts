import {
  noticeAttachmentInput,
  noticeInput,
  noticeUpdate,
  uuid,
  type NoticeRecord,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import type { ActorContext } from '../auth/session';
import { getPool, withTransaction } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, conflict, notFound, parseInput } from '../lib/errors';
import { toIsoDate, toIsoDateTime } from '../lib/format';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const attachmentParams = z.object({ schoolId: uuid, id: uuid, attachmentId: uuid });
const listQuery = z.object({
  status: z.enum(['draft', 'published', 'archived']).optional(),
});
const MAX_ATTACHMENT_BYTES = 1024 * 1024;

/**
 * School notices.
 *
 * Managers see drafts and archives. Everyone else sees only published,
 * non-expired notices addressed to an audience they belong to. The audience
 * mapping is derived from the actor's roles, not from a client-supplied value.
 */
export async function registerNoticeRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/schools/:schoolId/notices',
    { preHandler: requirePermission('notices.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const query = parseInput(listQuery, request.query);
      const manager = actor.permissions.has('notices.manage');

      const params: unknown[] = [schoolId, actor.userId];
      const conditions = ['n.school_id = $1'];

      if (manager) {
        if (query.status) {
          params.push(query.status);
          conditions.push(`n.status = $${params.length}`);
        }
      } else {
        conditions.push(`n.status = 'published'`);
        conditions.push(`(n.expires_on IS NULL OR n.expires_on >= current_date)`);
        const audiences = audiencesFor(actor);
        params.push(audiences);
        conditions.push(`n.audience = ANY($${params.length}::text[])`);
      }

      const { rows } = await getPool().query<NoticeRow>(
        `${noticeSelect('$2')} WHERE ${conditions.join(' AND ')}
         ORDER BY n.pinned DESC, n.published_at DESC NULLS LAST, n.created_at DESC`,
        params,
      );
      return { items: rows.map((row) => mapNotice(row, manager)) };
    },
  );

  app.post(
    '/api/schools/:schoolId/notices',
    { preHandler: requirePermission('notices.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(noticeInput, request.body);

      const created = await withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO notices
             (school_id, title, body, audience, status, pinned, expires_on, created_by)
           VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)
           RETURNING id`,
          [
            schoolId,
            input.title,
            input.body,
            input.audience,
            input.pinned,
            input.expiresOn ?? null,
            actor.userId,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'notices.draft_created',
          entityType: 'notice',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: input,
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });

      const { rows } = await getPool().query<NoticeRow>(
        `${noticeSelect('$3')} WHERE n.school_id = $1 AND n.id = $2`,
        [schoolId, created, actor.userId],
      );
      return reply.status(201).send(mapNotice(rows[0]!, true));
    },
  );

  app.patch(
    '/api/schools/:schoolId/notices/:id',
    { preHandler: requirePermission('notices.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(noticeUpdate, request.body);

      await withTransaction(async (client) => {
        const existing = await client.query<{
          id: string;
          title: string;
          body: string;
          audience: NoticeRecord['audience'];
          status: NoticeRecord['status'];
          pinned: boolean;
          published_at: Date | null;
          expires_on: string | null;
        }>(
          `SELECT id, title, body, audience, status, pinned, published_at, expires_on
           FROM notices WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Notice not found');

        const status = input.status ?? row.status;
        let publishedAt = row.published_at;
        if (status === 'draft') {
          publishedAt = null;
        } else if (!publishedAt) {
          publishedAt = new Date();
        }

        await client.query(
          `UPDATE notices
           SET title = $3, body = $4, audience = $5, status = $6, pinned = $7,
               expires_on = $8, published_at = $9
           WHERE school_id = $1 AND id = $2`,
          [
            schoolId,
            id,
            input.title ?? row.title,
            input.body ?? row.body,
            input.audience ?? row.audience,
            status,
            input.pinned ?? row.pinned,
            input.expiresOn === undefined ? row.expires_on : input.expiresOn,
            publishedAt,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action:
            status !== row.status
              ? `notices.${status === 'draft' ? 'unpublished' : status}`
              : 'notices.updated',
          entityType: 'notice',
          entityId: id,
          outcome: 'success',
          before: row,
          after: input,
          ...requestMeta(request),
        });
      });

      const { rows } = await getPool().query<NoticeRow>(
        `${noticeSelect('$3')} WHERE n.school_id = $1 AND n.id = $2`,
        [schoolId, id, actor.userId],
      );
      return mapNotice(rows[0]!, true);
    },
  );

  app.delete(
    '/api/schools/:schoolId/notices/:id',
    { preHandler: requirePermission('notices.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);

      await withTransaction(async (client) => {
        const existing = await client.query<{ status: NoticeRecord['status'] }>(
          'SELECT status FROM notices WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Notice not found');
        if (row.status === 'published') {
          throw conflict('Archive the notice before deleting it', 'notice_published');
        }
        await client.query('DELETE FROM notices WHERE school_id = $1 AND id = $2', [schoolId, id]);
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'notices.deleted',
          entityType: 'notice',
          entityId: id,
          outcome: 'success',
          before: { status: row.status },
          ...requestMeta(request),
        });
      });

      return reply.status(204).send();
    },
  );

  /* ------------------------------ attachments ------------------------------ */

  app.post(
    '/api/schools/:schoolId/notices/:id/attachments',
    { preHandler: requirePermission('notices.manage'), bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(noticeAttachmentInput, request.body);

      let buffer: Buffer;
      try {
        buffer = Buffer.from(input.dataBase64, 'base64');
      } catch {
        throw badRequest('Attachment could not be decoded');
      }
      if (buffer.length === 0) throw badRequest('The attachment is empty');
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        throw badRequest('Attachments must be 1 MiB or smaller');
      }

      const created = await withTransaction(async (client) => {
        const notice = await client.query('SELECT id FROM notices WHERE school_id = $1 AND id = $2', [
          schoolId,
          id,
        ]);
        if (!notice.rows[0]) throw notFound('Notice not found');

        const { rows } = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO notice_attachments
             (school_id, notice_id, filename, content_type, byte_size, data, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, created_at`,
          [schoolId, id, input.filename, input.contentType, buffer.length, buffer, actor.userId],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'notices.attachment_added',
          entityType: 'notice',
          entityId: id,
          outcome: 'success',
          after: { filename: input.filename, contentType: input.contentType, byteSize: buffer.length },
          ...requestMeta(request),
        });
        return rows[0]!;
      });

      return reply.status(201).send({
        id: created.id,
        filename: input.filename,
        contentType: input.contentType,
        byteSize: buffer.length,
        createdAt: toIsoDateTime(created.created_at),
      });
    },
  );

  app.get(
    '/api/schools/:schoolId/notices/:id/attachments/:attachmentId',
    { preHandler: requirePermission('notices.view') },
    async (request, reply) => {
      const { schoolId, id, attachmentId } = parseInput(attachmentParams, request.params);
      const actor = getActor(request);
      await assertNoticeVisible(schoolId, id, actor);

      const { rows } = await getPool().query<{
        filename: string;
        content_type: string;
        data: Buffer;
      }>(
        `SELECT filename, content_type, data FROM notice_attachments
         WHERE school_id = $1 AND notice_id = $2 AND id = $3`,
        [schoolId, id, attachmentId],
      );
      const file = rows[0];
      if (!file) throw notFound('Attachment not found');

      const safeName = file.filename.replace(/["\\\r\n]/g, '_');
      return reply
        .header('content-type', file.content_type)
        .header('content-disposition', `attachment; filename="${safeName}"`)
        .send(file.data);
    },
  );

  app.delete(
    '/api/schools/:schoolId/notices/:id/attachments/:attachmentId',
    { preHandler: requirePermission('notices.manage') },
    async (request, reply) => {
      const { schoolId, id, attachmentId } = parseInput(attachmentParams, request.params);
      const actor = getActor(request);

      await withTransaction(async (client) => {
        const { rows } = await client.query<{ filename: string }>(
          `DELETE FROM notice_attachments
           WHERE school_id = $1 AND notice_id = $2 AND id = $3
           RETURNING filename`,
          [schoolId, id, attachmentId],
        );
        if (!rows[0]) throw notFound('Attachment not found');
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'notices.attachment_removed',
          entityType: 'notice',
          entityId: id,
          outcome: 'success',
          before: { filename: rows[0].filename },
          ...requestMeta(request),
        });
      });

      return reply.status(204).send();
    },
  );

  /* ------------------------------ read receipts ---------------------------- */

  app.post(
    '/api/schools/:schoolId/notices/:id/read',
    { preHandler: requirePermission('notices.view') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      await assertNoticeVisible(schoolId, id, actor);

      await getPool().query(
        `INSERT INTO notice_receipts (school_id, notice_id, user_id, read_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (school_id, notice_id, user_id) DO UPDATE SET read_at = now()`,
        [schoolId, id, actor.userId],
      );
      return { readAt: toIsoDateTime(new Date()) };
    },
  );
}

/** Rejects reading/marking a notice the actor is not addressed by. */
async function assertNoticeVisible(
  schoolId: string,
  noticeId: string,
  actor: ActorContext,
): Promise<void> {
  const { rows } = await getPool().query<{
    status: NoticeRecord['status'];
    audience: NoticeRecord['audience'];
    expires_on: string | null;
  }>('SELECT status, audience, expires_on FROM notices WHERE school_id = $1 AND id = $2', [
    schoolId,
    noticeId,
  ]);
  const notice = rows[0];
  if (!notice) throw notFound('Notice not found');

  const manager = actor.permissions.has('notices.manage');
  if (manager) return;
  if (notice.status !== 'published') throw notFound('Notice not found');
  if (notice.expires_on && toIsoDate(notice.expires_on) < new Date().toISOString().slice(0, 10)) {
    throw notFound('Notice not found');
  }
  if (!audiencesFor(actor).includes(notice.audience)) throw notFound('Notice not found');
}

/* --------------------------------- helpers -------------------------------- */

interface NoticeAttachmentRow {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
}

interface NoticeRow {
  id: string;
  title: string;
  body: string;
  audience: NoticeRecord['audience'];
  status: NoticeRecord['status'];
  pinned: boolean;
  published_at: Date | null;
  expires_on: string | null;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  attachments: NoticeAttachmentRow[] | null;
  read_by_me: boolean;
  read_count: string;
}

function noticeSelect(actorParam: string): string {
  return `
  SELECT n.id, n.title, n.body, n.audience, n.status, n.pinned,
         n.published_at, n.expires_on, u.display_name AS created_by_name,
         n.created_at, n.updated_at,
         COALESCE((
           SELECT json_agg(
             json_build_object(
               'id', a.id,
               'filename', a.filename,
               'contentType', a.content_type,
               'byteSize', a.byte_size,
               'createdAt', a.created_at
             ) ORDER BY a.created_at
           )
           FROM notice_attachments a
           WHERE a.school_id = n.school_id AND a.notice_id = n.id
         ), '[]'::json) AS attachments,
         EXISTS (
           SELECT 1 FROM notice_receipts r
           WHERE r.school_id = n.school_id AND r.notice_id = n.id
             AND r.user_id = ${actorParam}
         ) AS read_by_me,
         (
           SELECT count(*) FROM notice_receipts r2
           WHERE r2.school_id = n.school_id AND r2.notice_id = n.id
         ) AS read_count
  FROM notices n
  LEFT JOIN users u ON u.id = n.created_by`;
}

function mapNotice(row: NoticeRow, manager: boolean): NoticeRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    audience: row.audience,
    status: row.status,
    pinned: row.pinned,
    publishedAt: row.published_at ? toIsoDateTime(row.published_at) : null,
    expiresOn: row.expires_on ? toIsoDate(row.expires_on) : null,
    createdByName: row.created_by_name,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
    attachments: (row.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      byteSize: Number(attachment.byteSize),
      createdAt: toIsoDateTime(attachment.createdAt),
    })),
    readByMe: row.read_by_me,
    readCount: manager ? Number(row.read_count) : null,
  };
}

function audiencesFor(actor: ActorContext): string[] {
  const audiences = new Set(['all']);
  const roles = new Set(actor.roleCodes);
  if (roles.has('parent')) audiences.add('parents');
  if (roles.has('student')) audiences.add('students');
  if (
    roles.has('teacher') ||
    roles.has('academic_coordinator') ||
    roles.has('main_admin') ||
    roles.has('finance') ||
    roles.has('auditor')
  ) {
    audiences.add('staff');
  }
  return [...audiences];
}
