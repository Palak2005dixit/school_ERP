import type { Permission } from '@erp/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadActor, type ActorContext } from './session';
import { getPool } from '../db';
import { forbidden, notFound, unauthorized } from '../lib/errors';
import { recordAudit } from '../lib/audit';

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.user) throw unauthorized();
}

/**
 * Authorizes a request against a school route parameter. Deny-by-default:
 * no active membership yields 404 (hide tenant existence), a missing
 * permission yields 403 and is recorded as a denied audit event.
 */
export function requirePermission(permission: Permission) {
  return async function guard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.user) throw unauthorized();

    const schoolId = (request.params as { schoolId?: string } | undefined)?.schoolId;
    if (!schoolId) throw notFound('School not found');

    const actor = await loadActor(request.user.id, schoolId);
    if (!actor) throw notFound('School not found');

    if (!actor.permissions.has(permission)) {
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: request.user.id,
        action: 'access.denied',
        entityType: 'permission',
        outcome: 'denied',
        reason: `missing ${permission}`,
        sourceIp: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      }).catch(() => undefined);
      throw forbidden();
    }

    request.actor = actor;
  };
}

/**
 * Guard that passes when the actor holds at least one of the listed
 * permissions. Used by shared endpoints such as the leave list, where a
 * teacher sees their own requests while an approver sees the whole queue.
 */
export function requireAnyPermission(...permissions: Permission[]) {
  return async function guard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.user) throw unauthorized();

    const schoolId = (request.params as { schoolId?: string } | undefined)?.schoolId;
    if (!schoolId) throw notFound('School not found');

    const actor = await loadActor(request.user.id, schoolId);
    if (!actor) throw notFound('School not found');

    if (!permissions.some((permission) => actor.permissions.has(permission))) {
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: request.user.id,
        action: 'access.denied',
        entityType: 'permission',
        outcome: 'denied',
        reason: `missing all of ${permissions.join(', ')}`,
        sourceIp: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      }).catch(() => undefined);
      throw forbidden();
    }

    request.actor = actor;
  };
}

export function getActor(request: FastifyRequest): ActorContext {
  if (!request.actor) throw unauthorized();
  return request.actor;
}

export function requestMeta(request: FastifyRequest): {
  sourceIp: string | null;
  userAgent: string | null;
} {
  return {
    sourceIp: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}
