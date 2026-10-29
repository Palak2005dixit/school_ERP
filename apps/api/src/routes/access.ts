import { hashPassword } from '@erp/core';
import {
  roleAssignmentInput,
  userInput,
  uuid,
  type Permission,
  type RoleSummary,
  type ScopeType,
  type UserRecord,
  type UserRoleAssignment,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound, parseInput } from '../lib/errors';
import { toIsoDateTime } from '../lib/format';

const schoolParams = z.object({ schoolId: uuid });
const userParams = z.object({ schoolId: uuid, id: uuid });
const assignmentParams = z.object({ schoolId: uuid, id: uuid, assignmentId: uuid });
const statusInput = z.object({
  status: z.enum(['active', 'locked', 'disabled']),
});

/**
 * User and role administration.
 *
 * Creating a user needs a password (no email delivery is configured), so the
 * administrator sets a strong temporary password and hands it over out of band.
 * Scope ids are validated against the school, and an administrator cannot
 * disable their own account or revoke their own final role assignment.
 */
export async function registerAccessRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/schools/:schoolId/roles',
    { preHandler: requirePermission('access.roles.manage') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const roles = await getPool().query<{
        code: string;
        name: string;
        description: string | null;
      }>('SELECT code, name, description FROM roles ORDER BY name');
      const permissions = await getPool().query<{ role_code: string; code: string }>(
        `SELECT r.code AS role_code, p.code
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
         ORDER BY r.code, p.code`,
      );
      const items: RoleSummary[] = roles.rows.map((role) => ({
        code: role.code,
        name: role.name,
        description: role.description ?? '',
        defaultScopeType: defaultScopeFor(role.code),
        permissions: permissions.rows
          .filter((row) => row.role_code === role.code)
          .map((row) => row.code as Permission),
      }));
      // The school id is only used for authorization; roles are global.
      void schoolId;
      return { items };
    },
  );

  app.get(
    '/api/schools/:schoolId/users',
    { preHandler: requirePermission('access.roles.manage') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const users = await getPool().query<{
        id: string;
        email: string | null;
        display_name: string;
        status: UserRecord['status'];
        created_at: Date;
      }>(
        `SELECT DISTINCT u.id, u.email, u.display_name, u.status, u.created_at
         FROM users u
         JOIN user_role_assignments ura ON ura.user_id = u.id
         WHERE ura.school_id = $1
         ORDER BY u.display_name`,
        [schoolId],
      );
      return {
        items: await Promise.all(users.rows.map((row) => loadUser(getPool(), schoolId, row))),
      };
    },
  );

  app.post(
    '/api/schools/:schoolId/users',
    { preHandler: requirePermission('access.roles.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(userInput, request.body);

      const existing = await getPool().query<{ id: string }>(
        'SELECT id FROM users WHERE lower(email) = lower($1)',
        [input.email],
      );
      if (existing.rows[0]) {
        throw conflict('An account with that email already exists', 'duplicate');
      }

      const passwordHash = await hashPassword(input.password);
      const userId = await withTransaction(async (client) => {
        const role = await loadRole(client, input.roleCode);
        const scope = await resolveScope(
          client,
          schoolId,
          input.roleCode,
          input.scopeType,
          input.scopeId ?? null,
        );

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO users (email, display_name, password_hash, status)
           VALUES ($1, $2, $3, 'active') RETURNING id`,
          [input.email, input.displayName, passwordHash],
        );
        const id = rows[0]!.id;

        await client.query(
          `INSERT INTO user_role_assignments
             (user_id, role_id, school_id, scope_type, scope_id, granted_by, reason)
           VALUES ($1, $2, $3, $4, $5, $6, 'Account created by administrator')`,
          [id, role.id, schoolId, scope.type, scope.id, actor.userId],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'access.user_created',
          entityType: 'user',
          entityId: id,
          outcome: 'success',
          // Never log the password or its hash.
          after: {
            email: input.email,
            displayName: input.displayName,
            roleCode: input.roleCode,
            scopeType: scope.type,
            scopeId: scope.id,
          },
          ...requestMeta(request),
        });
        return id;
      });

      const user = await getPool().query<{
        id: string;
        email: string | null;
        display_name: string;
        status: UserRecord['status'];
        created_at: Date;
      }>(
        'SELECT id, email, display_name, status, created_at FROM users WHERE id = $1',
        [userId],
      );
      return reply
        .status(201)
        .send(await loadUser(getPool(), schoolId, user.rows[0]!));
    },
  );

  app.patch(
    '/api/schools/:schoolId/users/:id/status',
    { preHandler: requirePermission('access.roles.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(userParams, request.params);
      const actor = getActor(request);
      const input = parseInput(statusInput, request.body);
      if (id === actor.userId && input.status !== 'active') {
        throw forbidden('You cannot disable or lock your own account');
      }

      await withTransaction(async (client) => {
        const existing = await client.query<{ status: string; display_name: string }>(
          'SELECT status, display_name FROM users WHERE id = $1 FOR UPDATE',
          [id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('User not found');
        const inSchool = await client.query(
          'SELECT 1 FROM user_role_assignments WHERE school_id = $1 AND user_id = $2 LIMIT 1',
          [schoolId, id],
        );
        if (inSchool.rowCount === 0) throw notFound('User not found');

        await client.query(
          `UPDATE users
           SET status = $2::text,
               failed_login_attempts = CASE WHEN $2::text = 'active' THEN 0 ELSE failed_login_attempts END,
               locked_until = CASE WHEN $2::text = 'active' THEN NULL ELSE locked_until END
           WHERE id = $1`,
          [id, input.status],
        );
        if (input.status !== 'active') {
          await client.query(
            'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
            [id],
          );
        }
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'access.user_status_changed',
          entityType: 'user',
          entityId: id,
          outcome: 'success',
          before: { status: row.status },
          after: { status: input.status },
          ...requestMeta(request),
        });
      });

      const { rows } = await getPool().query<{
        id: string;
        email: string | null;
        display_name: string;
        status: UserRecord['status'];
        created_at: Date;
      }>('SELECT id, email, display_name, status, created_at FROM users WHERE id = $1', [id]);
      return loadUser(getPool(), schoolId, rows[0]!);
    },
  );

  app.post(
    '/api/schools/:schoolId/users/:id/roles',
    { preHandler: requirePermission('access.roles.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(userParams, request.params);
      const actor = getActor(request);
      const input = parseInput(roleAssignmentInput, request.body);

      const assignmentId = await withTransaction(async (client) => {
        const user = await client.query<{ display_name: string }>(
          'SELECT display_name FROM users WHERE id = $1',
          [id],
        );
        if (!user.rows[0]) throw notFound('User not found');
        const role = await loadRole(client, input.roleCode);
        const scope = await resolveScope(
          client,
          schoolId,
          input.roleCode,
          input.scopeType,
          input.scopeId ?? null,
        );

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO user_role_assignments
             (user_id, role_id, school_id, scope_type, scope_id, granted_by, reason)
           VALUES ($1, $2, $3, $4, $5, $6, 'Role granted by administrator')
           RETURNING id`,
          [id, role.id, schoolId, scope.type, scope.id, actor.userId],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'access.role_granted',
          entityType: 'user',
          entityId: id,
          outcome: 'success',
          after: { roleCode: input.roleCode, scopeType: scope.type, scopeId: scope.id },
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });

      return reply.status(201).send({ id: assignmentId });
    },
  );

  app.delete(
    '/api/schools/:schoolId/users/:id/roles/:assignmentId',
    { preHandler: requirePermission('access.roles.manage') },
    async (request, reply) => {
      const { schoolId, id, assignmentId } = parseInput(assignmentParams, request.params);
      const actor = getActor(request);

      await withTransaction(async (client) => {
        const existing = await client.query<{
          id: string;
          user_id: string;
          role_id: string;
          role_code: string;
          revoked_at: Date | null;
        }>(
          `SELECT ura.id, ura.user_id, ura.role_id, r.code AS role_code, ura.revoked_at
           FROM user_role_assignments ura
           JOIN roles r ON r.id = ura.role_id
           WHERE ura.school_id = $1 AND ura.user_id = $2 AND ura.id = $3 FOR UPDATE`,
          [schoolId, id, assignmentId],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Role assignment not found');
        if (row.revoked_at) throw conflict('That role assignment is already revoked');

        if (id === actor.userId) {
          const remaining = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM user_role_assignments
             WHERE school_id = $1 AND user_id = $2 AND revoked_at IS NULL
               AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
               AND id <> $3`,
            [schoolId, id, assignmentId],
          );
          if (Number(remaining.rows[0]!.count) === 0) {
            throw forbidden('You cannot revoke your own last role assignment');
          }
        }

        await client.query(
          'UPDATE user_role_assignments SET revoked_at = now() WHERE id = $1',
          [assignmentId],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'access.role_revoked',
          entityType: 'user',
          entityId: id,
          outcome: 'success',
          before: { roleCode: row.role_code, assignmentId },
          ...requestMeta(request),
        });
      });

      return reply.status(204).send();
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

interface UserRow {
  id: string;
  email: string | null;
  display_name: string;
  status: UserRecord['status'];
  created_at: Date;
}

async function loadUser(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  row: UserRow,
): Promise<UserRecord> {
  const { rows } = await client.query<{
    assignment_id: string;
    role_code: string;
    role_name: string;
    scope_type: ScopeType;
    scope_id: string | null;
    scope_label: string | null;
  }>(
    `SELECT ura.id AS assignment_id, r.code AS role_code, r.name AS role_name,
            ura.scope_type, ura.scope_id,
            CASE
              WHEN ura.scope_type = 'section' THEN concat(c.name, ' · ', sec.name)
              WHEN ura.scope_type = 'class' THEN c2.name
              WHEN ura.scope_type = 'school' THEN s.name
              WHEN ura.scope_type = 'linked_student' THEN 'Linked children'
              WHEN ura.scope_type = 'self' THEN 'Own record'
              ELSE NULL
            END AS scope_label
     FROM user_role_assignments ura
     JOIN roles r ON r.id = ura.role_id
     JOIN schools s ON s.id = ura.school_id
     LEFT JOIN sections sec ON sec.id = ura.scope_id AND ura.scope_type = 'section'
     LEFT JOIN classes c ON c.id = sec.class_id
     LEFT JOIN classes c2 ON c2.id = ura.scope_id AND ura.scope_type = 'class'
     WHERE ura.school_id = $1 AND ura.user_id = $2
       AND ura.revoked_at IS NULL
       AND ura.valid_from <= now()
       AND (ura.valid_to IS NULL OR ura.valid_to > now())
     ORDER BY r.name`,
    [schoolId, row.id],
  );

  const roles: UserRoleAssignment[] = rows.map((assignment) => ({
    assignmentId: assignment.assignment_id,
    roleCode: assignment.role_code,
    roleName: assignment.role_name,
    scopeType: assignment.scope_type,
    scopeId: assignment.scope_id,
    scopeLabel: assignment.scope_label,
  }));

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    createdAt: toIsoDateTime(row.created_at),
    roles,
  };
}

async function loadRole(
  client: pg.PoolClient,
  roleCode: string,
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM roles WHERE code = $1',
    [roleCode],
  );
  if (!rows[0]) {
    throw badRequest('Choose a valid role', { roleCode: ['That role does not exist'] });
  }
  return rows[0];
}

async function resolveScope(
  client: pg.PoolClient,
  schoolId: string,
  roleCode: string,
  requestedType: ScopeType | undefined,
  requestedId: string | null,
): Promise<{ type: ScopeType; id: string | null }> {
  const type = requestedType ?? defaultScopeFor(roleCode);

  if (type === 'school' || type === 'self' || type === 'linked_student') {
    if (requestedId) {
      throw badRequest('That scope does not take a record id', {
        scopeId: ['Leave the scope record empty for this scope type'],
      });
    }
    return { type, id: null };
  }

  if (!requestedId) {
    throw badRequest('Choose the record this role applies to', {
      scopeId: ['A class, section or department is required for this scope'],
    });
  }

  if (type === 'section') {
    const { rowCount } = await client.query(
      'SELECT 1 FROM sections WHERE school_id = $1 AND id = $2',
      [schoolId, requestedId],
    );
    if (rowCount === 0) throw notFound('Section not found');
  } else if (type === 'class') {
    const { rowCount } = await client.query(
      'SELECT 1 FROM classes WHERE school_id = $1 AND id = $2',
      [schoolId, requestedId],
    );
    if (rowCount === 0) throw notFound('Class not found');
  } else if (type === 'campus') {
    const { rowCount } = await client.query(
      'SELECT 1 FROM campuses WHERE school_id = $1 AND id = $2',
      [schoolId, requestedId],
    );
    if (rowCount === 0) throw notFound('Campus not found');
  }

  return { type, id: requestedId };
}

function defaultScopeFor(roleCode: string): ScopeType {
  switch (roleCode) {
    case 'teacher':
      return 'section';
    case 'parent':
      return 'linked_student';
    case 'student':
      return 'self';
    default:
      return 'school';
  }
}
