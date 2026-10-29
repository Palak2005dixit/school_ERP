import { createSessionToken, sha256Hex } from '@erp/core';
import type { MembershipSummary, Permission, SessionUser } from '@erp/shared';
import type { ScopeAssignment } from '@erp/core';
import { config } from '../config';
import { getPool } from '../db';

export interface ActorContext {
  userId: string;
  schoolId: string;
  school: {
    id: string;
    name: string;
    code: string;
    timezone: string;
  };
  roleCodes: string[];
  permissions: ReadonlySet<string>;
  assignments: ScopeAssignment[];
  displayName: string;
  email: string | null;
}

export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
  await getPool().query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [sha256Hex(token), userId, expiresAt, meta.ip ?? null, meta.userAgent ?? null],
  );
  return { token, expiresAt };
}

export async function revokeSession(token: string): Promise<void> {
  await getPool().query(
    `UPDATE sessions SET revoked_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sha256Hex(token)],
  );
}

export async function loadSessionUser(token: string): Promise<SessionUser | null> {
  const { rows } = await getPool().query<{
    id: string;
    email: string | null;
    display_name: string;
    status: SessionUser['status'];
    session_id: string;
    stale: boolean;
  }>(
    `SELECT u.id, u.email, u.display_name, u.status, s.id AS session_id,
            (s.last_seen_at < now() - interval '5 minutes') AS stale
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.status = 'active'`,
    [sha256Hex(token)],
  );

  const row = rows[0];
  if (!row) return null;

  if (row.stale) {
    void getPool()
      .query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id])
      .catch(() => undefined);
  }

  return { id: row.id, email: row.email, displayName: row.display_name, status: row.status };
}

/**
 * Aggregated permissions per school. Expired and revoked assignments are
 * excluded here, so role changes take effect on the next request.
 */
export async function loadMemberships(userId: string): Promise<MembershipSummary[]> {
  const { rows } = await getPool().query<{
    school_id: string;
    school_name: string;
    school_code: string;
    timezone: string;
    roles: string[];
    permissions: string[];
  }>(
    `SELECT s.id AS school_id,
            s.name AS school_name,
            s.code AS school_code,
            s.timezone,
            array_agg(DISTINCT r.code ORDER BY r.code) AS roles,
            array_agg(DISTINCT p.code ORDER BY p.code) AS permissions
     FROM user_role_assignments ura
     JOIN schools s ON s.id = ura.school_id AND s.status = 'active'
     JOIN roles r ON r.id = ura.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ura.user_id = $1
       AND ura.revoked_at IS NULL
       AND ura.valid_from <= now()
       AND (ura.valid_to IS NULL OR ura.valid_to > now())
     GROUP BY s.id
     ORDER BY s.name`,
    [userId],
  );

  return rows.map((row) => ({
    schoolId: row.school_id,
    schoolName: row.school_name,
    schoolCode: row.school_code,
    timezone: row.timezone,
    roles: row.roles,
    permissions: row.permissions as Permission[],
  }));
}

/**
 * Resolves the actor's authority inside one school. Returns null when the user
 * has no active membership, which the caller reports as 404 (not 403) so
 * outsiders cannot probe which school IDs exist.
 */
export async function loadActor(userId: string, schoolId: string): Promise<ActorContext | null> {
  const client = await getPool().connect();
  try {
    const schoolResult = await client.query<{
      id: string;
      name: string;
      code: string;
      timezone: string;
      display_name: string;
      email: string | null;
    }>(
      `SELECT s.id, s.name, s.code, s.timezone, u.display_name, u.email
       FROM schools s
       JOIN users u ON u.id = $2
       WHERE s.id = $1 AND s.status = 'active'`,
      [schoolId, userId],
    );
    const school = schoolResult.rows[0];
    if (!school) return null;

    const access = await client.query<{
      scope_type: ScopeAssignment['scopeType'];
      scope_id: string | null;
      role_code: string;
      permission_code: string | null;
    }>(
      `SELECT ura.scope_type, ura.scope_id, r.code AS role_code, p.code AS permission_code
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE ura.user_id = $1
         AND ura.school_id = $2
         AND ura.revoked_at IS NULL
         AND ura.valid_from <= now()
         AND (ura.valid_to IS NULL OR ura.valid_to > now())`,
      [userId, schoolId],
    );

    if (access.rows.length === 0) return null;

    const permissions = new Set<string>();
    const roleCodes = new Set<string>();
    const assignments: ScopeAssignment[] = [];
    for (const row of access.rows) {
      roleCodes.add(row.role_code);
      if (row.permission_code) permissions.add(row.permission_code);
      if (!assignments.some((a) => a.scopeType === row.scope_type && a.scopeId === row.scope_id)) {
        assignments.push({ scopeType: row.scope_type, scopeId: row.scope_id });
      }
    }

    return {
      userId,
      schoolId,
      school: {
        id: school.id,
        name: school.name,
        code: school.code,
        timezone: school.timezone,
      },
      roleCodes: [...roleCodes].sort(),
      permissions,
      assignments,
      displayName: school.display_name,
      email: school.email,
    };
  } finally {
    client.release();
  }
}
