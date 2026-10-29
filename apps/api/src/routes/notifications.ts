import {
  inAppNotificationInput,
  notificationPreferenceInput,
  notificationQueueInput,
  notificationTemplateInput,
  notificationTemplateUpdate,
  uuid,
  type InAppNotification,
  type NotificationOutboxRecord,
  type NotificationPreference,
  type NotificationProviderStatus,
  type NotificationTemplate,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAnyPermission, requirePermission, requestMeta } from '../auth/guards';
import { getPool } from '../db';
import { recordAudit } from '../lib/audit';
import { conflict, notFound, parseInput } from '../lib/errors';
import { toIsoDateTime } from '../lib/format';
import { idempotentRoute } from '../lib/idempotency';
import { getNotificationProvider } from '../lib/notifications/provider';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const inboxQuery = z.object({ unreadOnly: z.enum(['true', 'false']).optional() });
const outboxQuery = z.object({
  status: z
    .enum(['queued', 'processing', 'sent', 'failed', 'blocked', 'cancelled'])
    .optional(),
  channel: z.enum(['email', 'sms', 'whatsapp']).optional(),
});
const DELIVERY_CHANNELS = ['email', 'sms', 'whatsapp'] as const;

/**
 * In-app inbox, templates and the external delivery outbox.
 *
 * In-app notifications are always available. Email/SMS/WhatsApp messages are
 * only queued when the recipient has opted in (consent recorded per channel) and
 * are only marked `sent` after the configured provider confirms delivery. With
 * no provider the row is recorded as `blocked`; nothing is ever reported as
 * sent without a provider response.
 */
export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------- inbox -------------------------------- */

  app.get(
    '/api/schools/:schoolId/notifications',
    { preHandler: requirePermission('notifications.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(inboxQuery, request.query);
      const actor = getActor(request);
      const params: unknown[] = [schoolId, actor.userId];
      let filter = '';
      if (query.unreadOnly === 'true') filter = 'AND read_at IS NULL';
      const { rows } = await getPool().query<{
        id: string;
        title: string;
        body: string;
        link: string | null;
        category: string;
        read_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, title, body, link, category, read_at, created_at
         FROM in_app_notifications
         WHERE school_id = $1 AND user_id = $2 ${filter}
         ORDER BY created_at DESC
         LIMIT 200`,
        params,
      );
      const unread = await getPool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM in_app_notifications
         WHERE school_id = $1 AND user_id = $2 AND read_at IS NULL`,
        [schoolId, actor.userId],
      );
      const items: InAppNotification[] = rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        link: row.link,
        category: row.category,
        readAt: row.read_at ? toIsoDateTime(row.read_at) : null,
        createdAt: toIsoDateTime(row.created_at),
      }));
      return { items, unread: Number(unread.rows[0]?.count ?? 0) };
    },
  );

  app.post(
    '/api/schools/:schoolId/notifications/:id/read',
    { preHandler: requirePermission('notifications.view') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const { rows } = await getPool().query<{ id: string; read_at: Date | null }>(
        `UPDATE in_app_notifications SET read_at = COALESCE(read_at, now())
         WHERE school_id = $1 AND user_id = $2 AND id = $3
         RETURNING id, read_at`,
        [schoolId, actor.userId, id],
      );
      if (!rows[0]) throw notFound('Notification not found');
      return { id, readAt: rows[0].read_at ? toIsoDateTime(rows[0].read_at) : null };
    },
  );

  app.post(
    '/api/schools/:schoolId/notifications/read-all',
    { preHandler: requirePermission('notifications.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const { rowCount } = await getPool().query(
        `UPDATE in_app_notifications SET read_at = now()
         WHERE school_id = $1 AND user_id = $2 AND read_at IS NULL`,
        [schoolId, actor.userId],
      );
      return { marked: rowCount ?? 0 };
    },
  );

  app.post(
    '/api/schools/:schoolId/notifications/in-app',
    { preHandler: requireAnyPermission('notifications.manage', 'notifications.send') },
    idempotentRoute('POST /notifications/in-app', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(inAppNotificationInput, request.body);
      const actor = getActor(request);
      const recipient = await getPool().query(
        `SELECT 1 FROM user_role_assignments
         WHERE school_id = $1 AND user_id = $2 AND revoked_at IS NULL LIMIT 1`,
        [schoolId, input.userId],
      );
      if (recipient.rowCount === 0) throw notFound('Recipient not found in this school');
      const preference = await getPool().query<{ enabled: boolean }>(
        `SELECT enabled FROM notification_preferences
         WHERE school_id = $1 AND user_id = $2 AND channel = 'inapp'`,
        [schoolId, input.userId],
      );
      if (preference.rows[0] && !preference.rows[0].enabled) {
        throw conflict('This user has disabled in-app notifications');
      }
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO in_app_notifications
           (school_id, user_id, title, body, link, category, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          schoolId,
          input.userId,
          input.title,
          input.body,
          input.link ?? null,
          input.category ?? 'general',
          input.dedupeKey ?? null,
        ],
      );
      if (!rows[0]) {
        if (!input.dedupeKey) throw conflict('The notification could not be created');
        const existing = await getPool().query<{ id: string }>(
          `SELECT id FROM in_app_notifications
           WHERE school_id = $1 AND user_id = $2 AND dedupe_key = $3`,
          [schoolId, input.userId, input.dedupeKey],
        );
        if (!existing.rows[0]) throw conflict('The notification could not be created');
        return { id: existing.rows[0].id, deduplicated: true };
      }
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'notifications.in_app_sent',
        entityType: 'in_app_notification',
        entityId: rows[0].id,
        outcome: 'success',
        after: { userId: input.userId, category: input.category ?? 'general' },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0].id, deduplicated: false });
    }),
  );

  /* -------------------------------- templates ------------------------------ */

  app.get(
    '/api/schools/:schoolId/notifications/templates',
    { preHandler: requirePermission('notifications.manage') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        code: string;
        channel: NotificationTemplate['channel'];
        subject: string | null;
        body: string;
        active: boolean;
      }>(
        `SELECT id, code, channel, subject, body, active
         FROM notification_templates WHERE school_id = $1 ORDER BY code, channel`,
        [schoolId],
      );
      const items: NotificationTemplate[] = rows.map((row) => ({
        id: row.id,
        code: row.code,
        channel: row.channel,
        subject: row.subject,
        body: row.body,
        active: row.active,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/notifications/templates',
    { preHandler: requirePermission('notifications.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(notificationTemplateInput, request.body);
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO notification_templates
           (school_id, code, channel, subject, body, active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [schoolId, input.code, input.channel, input.subject ?? null, input.body, input.active],
      );
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  app.patch(
    '/api/schools/:schoolId/notifications/templates/:id',
    { preHandler: requirePermission('notifications.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(notificationTemplateUpdate, request.body);
      const { rows } = await getPool().query<{
        code: string;
        channel: NotificationTemplate['channel'];
        subject: string | null;
        body: string;
        active: boolean;
      }>(
        `SELECT code, channel, subject, body, active FROM notification_templates
         WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      );
      const row = rows[0];
      if (!row) throw notFound('Template not found');
      await getPool().query(
        `UPDATE notification_templates SET
           code = $3, channel = $4, subject = $5, body = $6, active = $7
         WHERE school_id = $1 AND id = $2`,
        [
          schoolId,
          id,
          input.code ?? row.code,
          input.channel ?? row.channel,
          input.subject === undefined ? row.subject : input.subject,
          input.body ?? row.body,
          input.active ?? row.active,
        ],
      );
      return { id };
    },
  );

  /* ------------------------------ preferences ------------------------------ */

  app.get(
    '/api/schools/:schoolId/notifications/preferences',
    { preHandler: requirePermission('notifications.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const { rows } = await getPool().query<{
        channel: NotificationPreference['channel'];
        enabled: boolean;
        consent_given_at: Date | null;
      }>(
        `SELECT channel, enabled, consent_given_at FROM notification_preferences
         WHERE school_id = $1 AND user_id = $2`,
        [schoolId, actor.userId],
      );
      const byChannel = new Map(rows.map((row) => [row.channel, row]));
      const items: NotificationPreference[] = (
        ['inapp', 'email', 'sms', 'whatsapp'] as const
      ).map((channel) => {
        const row = byChannel.get(channel);
        return {
          channel,
          enabled: row ? row.enabled : channel === 'inapp',
          consentGivenAt: row?.consent_given_at ? toIsoDateTime(row.consent_given_at) : null,
        };
      });
      return { items };
    },
  );

  app.put(
    '/api/schools/:schoolId/notifications/preferences',
    { preHandler: requirePermission('notifications.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(notificationPreferenceInput, request.body);
      const actor = getActor(request);
      const external = input.channel !== 'inapp';
      if (external && input.enabled && !input.consent) {
        throw conflict('Record consent before enabling this delivery channel');
      }
      const existing = await getPool().query<{ consent_given_at: Date | null }>(
        `SELECT consent_given_at FROM notification_preferences
         WHERE school_id = $1 AND user_id = $2 AND channel = $3`,
        [schoolId, actor.userId, input.channel],
      );
      const consentGivenAt = external
        ? input.enabled
          ? (existing.rows[0]?.consent_given_at ?? new Date())
          : input.consent
            ? (existing.rows[0]?.consent_given_at ?? new Date())
            : null
        : null;
      await getPool().query(
        `INSERT INTO notification_preferences
           (school_id, user_id, channel, enabled, consent_given_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (school_id, user_id, channel) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           consent_given_at = EXCLUDED.consent_given_at,
           updated_at = now()`,
        [schoolId, actor.userId, input.channel, input.enabled, consentGivenAt],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'notifications.preference_updated',
        entityType: 'notification_preference',
        entityId: null,
        outcome: 'success',
        after: { channel: input.channel, enabled: input.enabled, consent: input.consent },
        ...requestMeta(request),
      });
      return {
        channel: input.channel,
        enabled: input.enabled,
        consentGivenAt: consentGivenAt ? consentGivenAt.toISOString() : null,
      };
    },
  );

  /* --------------------------------- outbox -------------------------------- */

  app.get(
    '/api/schools/:schoolId/notifications/provider-status',
    { preHandler: requirePermission('notifications.manage') },
    async (): Promise<NotificationProviderStatus> => {
      const provider = getNotificationProvider();
      return provider
        ? {
            configured: true,
            provider: provider.name,
            message: 'External delivery is configured.',
          }
        : {
            configured: false,
            provider: null,
            message:
              'No external delivery provider is configured. Messages are recorded as blocked and are never marked sent.',
          };
    },
  );

  app.get(
    '/api/schools/:schoolId/notifications/outbox',
    { preHandler: requireAnyPermission('notifications.manage', 'notifications.send') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(outboxQuery, request.query);
      const params: unknown[] = [schoolId];
      const filters = ['school_id = $1'];
      if (query.status) {
        params.push(query.status);
        filters.push(`status = $${params.length}`);
      }
      if (query.channel) {
        params.push(query.channel);
        filters.push(`channel = $${params.length}`);
      }
      const { rows } = await getPool().query<OutboxRow>(
        `SELECT id, channel, recipient_address, template_code, subject, body, status,
                attempts, max_attempts, next_attempt_at, last_error, provider, created_at,
                sent_at
         FROM notification_outbox
         WHERE ${filters.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT 200`,
        params,
      );
      return { items: rows.map(toOutbox) };
    },
  );

  app.get(
    '/api/schools/:schoolId/notifications/outbox/:id',
    { preHandler: requireAnyPermission('notifications.manage', 'notifications.send') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const { rows } = await getPool().query<OutboxRow>(
        `SELECT id, channel, recipient_address, template_code, subject, body, status,
                attempts, max_attempts, next_attempt_at, last_error, provider, created_at,
                sent_at
         FROM notification_outbox WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      );
      if (!rows[0]) throw notFound('Message not found');
      const attempts = await getPool().query<{
        attempt_no: number;
        outcome: string;
        provider: string | null;
        error: string | null;
        occurred_at: Date;
      }>(
        `SELECT attempt_no, outcome, provider, error, occurred_at
         FROM notification_attempts
         WHERE school_id = $1 AND outbox_id = $2 ORDER BY attempt_no`,
        [schoolId, id],
      );
      return {
        ...toOutbox(rows[0]),
        attemptsLog: attempts.rows.map((attempt) => ({
          attemptNo: attempt.attempt_no,
          outcome: attempt.outcome,
          provider: attempt.provider,
          error: attempt.error,
          occurredAt: toIsoDateTime(attempt.occurred_at),
        })),
      };
    },
  );

  app.post(
    '/api/schools/:schoolId/notifications/outbox',
    { preHandler: requirePermission('notifications.send') },
    idempotentRoute('POST /notifications/outbox', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(notificationQueueInput, request.body);
      const actor = getActor(request);

      if (input.recipientUserId) {
        const recipient = await getPool().query(
          `SELECT 1 FROM user_role_assignments
           WHERE school_id = $1 AND user_id = $2 AND revoked_at IS NULL LIMIT 1`,
          [schoolId, input.recipientUserId],
        );
        if (recipient.rowCount === 0) throw notFound('Recipient not found in this school');
        const preference = await getPool().query<{
          enabled: boolean;
          consent_given_at: Date | null;
        }>(
          `SELECT enabled, consent_given_at FROM notification_preferences
           WHERE school_id = $1 AND user_id = $2 AND channel = $3`,
          [schoolId, input.recipientUserId, input.channel],
        );
        const row = preference.rows[0];
        if (!row || !row.enabled || !row.consent_given_at) {
          throw conflict(
            'The recipient has not consented to this delivery channel, so the message was not queued',
            'consent_required',
          );
        }
      }

      const provider = getNotificationProvider();
      const blocked = provider === null;
      const blockMessage =
        'No external delivery provider is configured. This message was not sent.';
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO notification_outbox
           (school_id, channel, recipient_user_id, recipient_address, template_code,
            subject, body, status, attempts, next_attempt_at, last_error, dedupe_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          schoolId,
          input.channel,
          input.recipientUserId ?? null,
          input.recipientAddress,
          input.templateCode ?? null,
          input.subject ?? null,
          input.body,
          blocked ? 'blocked' : 'queued',
          blocked ? 1 : 0,
          blocked ? blockMessage : null,
          input.dedupeKey ?? null,
          actor.userId,
        ],
      );

      if (!rows[0]) {
        if (!input.dedupeKey) throw conflict('The message could not be queued');
        const existing = await getPool().query<{ id: string; status: string }>(
          `SELECT id, status FROM notification_outbox
           WHERE school_id = $1 AND dedupe_key = $2`,
          [schoolId, input.dedupeKey],
        );
        if (!existing.rows[0]) throw conflict('The message could not be queued');
        return { id: existing.rows[0].id, status: existing.rows[0].status, deduplicated: true };
      }

      const outboxId = rows[0].id;
      if (blocked) {
        await getPool().query(
          `INSERT INTO notification_attempts
             (school_id, outbox_id, attempt_no, outcome, provider, error)
           VALUES ($1, $2, 1, 'blocked', NULL, $3)`,
          [schoolId, outboxId, blockMessage],
        );
      }
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'notifications.queued',
        entityType: 'notification_outbox',
        entityId: outboxId,
        outcome: 'success',
        after: {
          channel: input.channel,
          status: blocked ? 'blocked' : 'queued',
          templateCode: input.templateCode ?? null,
        },
        ...requestMeta(request),
      });
      return reply.status(201).send({
        id: outboxId,
        status: blocked ? 'blocked' : 'queued',
        deduplicated: false,
      });
    }),
  );

  app.post(
    '/api/schools/:schoolId/notifications/outbox/:id/send',
    { preHandler: requirePermission('notifications.send') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const result = await deliver(schoolId, id, actor.userId, requestMeta(request));
      return result;
    },
  );

  app.post(
    '/api/schools/:schoolId/notifications/outbox/dispatch',
    { preHandler: requirePermission('notifications.send') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      await recoverStaleOutbox(schoolId);
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id FROM notification_outbox
         WHERE school_id = $1 AND status = 'queued'
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           AND attempts < max_attempts
         ORDER BY created_at
         LIMIT 50`,
        [schoolId],
      );
      const summary = { attempted: 0, sent: 0, failed: 0, blocked: 0 };
      for (const row of rows) {
        const outcome = await deliver(schoolId, row.id, actor.userId, requestMeta(request));
        summary.attempted += 1;
        if (outcome.status === 'sent') summary.sent += 1;
        else if (outcome.status === 'blocked') summary.blocked += 1;
        else if (outcome.status === 'failed') summary.failed += 1;
      }
      return summary;
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

interface OutboxRow {
  id: string;
  channel: NotificationOutboxRecord['channel'];
  recipient_address: string;
  template_code: string | null;
  subject: string | null;
  body: string;
  status: NotificationOutboxRecord['status'];
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  provider: string | null;
  created_at: Date;
  sent_at: Date | null;
}

function toOutbox(row: OutboxRow): NotificationOutboxRecord {
  return {
    id: row.id,
    channel: row.channel,
    recipientAddress: row.recipient_address,
    templateCode: row.template_code,
    subject: row.subject,
    body: row.body,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at ? toIsoDateTime(row.next_attempt_at) : null,
    lastError: row.last_error,
    provider: row.provider,
    createdAt: toIsoDateTime(row.created_at),
    sentAt: row.sent_at ? toIsoDateTime(row.sent_at) : null,
  };
}

async function recoverStaleOutbox(schoolId?: string): Promise<void> {
  const params: unknown[] = [];
  let filter = '';
  if (schoolId) {
    params.push(schoolId);
    filter = 'AND school_id = $1';
  }
  await getPool().query(
    `UPDATE notification_outbox SET status = 'queued'
     WHERE status = 'processing' AND updated_at < now() - interval '15 minutes' ${filter}`,
    params,
  );
}

async function deliver(
  schoolId: string,
  id: string,
  actorUserId: string,
  meta: { sourceIp: string | null; userAgent: string | null },
): Promise<{ id: string; status: string }> {
  const claim = await getPool().query<{
    channel: NotificationOutboxRecord['channel'];
    recipient_address: string;
    subject: string | null;
    body: string;
    attempts: number;
    max_attempts: number;
  }>(
    `UPDATE notification_outbox SET status = 'processing'
     WHERE school_id = $1 AND id = $2
       AND status IN ('queued', 'failed', 'blocked')
       AND attempts < max_attempts
     RETURNING channel, recipient_address, subject, body, attempts, max_attempts`,
    [schoolId, id],
  );
  const row = claim.rows[0];
  if (!row) {
    const existing = await getPool().query<{ status: string; attempts: number; max_attempts: number }>(
      `SELECT status, attempts, max_attempts FROM notification_outbox
       WHERE school_id = $1 AND id = $2`,
      [schoolId, id],
    );
    const current = existing.rows[0];
    if (!current) throw notFound('Message not found');
    if (current.status === 'sent') throw conflict('This message was already sent');
    if (current.attempts >= current.max_attempts) {
      throw conflict('This message has reached its delivery attempt limit');
    }
    throw conflict('This message is currently being processed');
  }

  const attemptNo = row.attempts + 1;
  const provider = getNotificationProvider();
  if (!provider) {
    const message =
      'No external delivery provider is configured. This message was not sent.';
    await finishAttempt(schoolId, id, attemptNo, 'blocked', null, message, true);
    await recordAudit(getPool(), {
      schoolId,
      actorUserId,
      action: 'notifications.delivery_blocked',
      entityType: 'notification_outbox',
      entityId: id,
      outcome: 'failure',
      reason: message,
      after: { attemptNo },
      ...meta,
    });
    return { id, status: 'blocked' };
  }

  try {
    const delivery = await provider.send({
      channel: row.channel,
      to: row.recipient_address,
      subject: row.subject,
      body: row.body,
    });
    await finishAttempt(
      schoolId,
      id,
      attemptNo,
      'sent',
      delivery.provider,
      null,
      false,
      delivery.messageId,
    );
    await recordAudit(getPool(), {
      schoolId,
      actorUserId,
      action: 'notifications.delivered',
      entityType: 'notification_outbox',
      entityId: id,
      outcome: 'success',
      after: { attemptNo, provider: delivery.provider },
      ...meta,
    });
    return { id, status: 'sent' };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Delivery failed';
    const finalAttempt = attemptNo >= row.max_attempts;
    await finishAttempt(
      schoolId,
      id,
      attemptNo,
      'failed',
      provider.name,
      message,
      finalAttempt,
    );
    await recordAudit(getPool(), {
      schoolId,
      actorUserId,
      action: 'notifications.delivery_failed',
      entityType: 'notification_outbox',
      entityId: id,
      outcome: 'failure',
      reason: message,
      after: { attemptNo, finalAttempt },
      ...meta,
    });
    return { id, status: finalAttempt ? 'failed' : 'queued' };
  }
}

async function finishAttempt(
  schoolId: string,
  id: string,
  attemptNo: number,
  outcome: 'sent' | 'failed' | 'blocked',
  provider: string | null,
  error: string | null,
  stop: boolean,
  providerMessageId = '',
): Promise<void> {
  const status =
    outcome === 'sent'
      ? 'sent'
      : outcome === 'blocked'
        ? 'blocked'
        : stop
          ? 'failed'
          : 'queued';
  await getPool().query(
    `UPDATE notification_outbox SET
       status = $3,
       attempts = $4,
       last_error = $5,
       provider = $6,
       provider_message_id = $7,
       sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE NULL END,
       next_attempt_at = CASE WHEN $3 = 'queued' THEN now() + interval '5 minutes' ELSE NULL END
     WHERE school_id = $1 AND id = $2`,
    [schoolId, id, status, attemptNo, error, provider, providerMessageId || null],
  );
  await getPool().query(
    `INSERT INTO notification_attempts
       (school_id, outbox_id, attempt_no, outcome, provider, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [schoolId, id, attemptNo, outcome, provider, error],
  );
}

// Referenced so the channel list stays documented next to the routes.
void DELIVERY_CHANNELS;
