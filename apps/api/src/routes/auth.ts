import { hashPassword, verifyPassword } from '@erp/core';
import {
  changePasswordSchema,
  loginSchema,
  mfaCodeSchema,
  mfaDisableSchema,
  passwordForgotSchema,
  passwordResetSchema,
  type MeResponse,
} from '@erp/shared';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, config } from '../config';
import { getPool, withTransaction } from '../db';
import { requireAuth } from '../auth/guards';
import { createSession, loadMemberships, revokeSession } from '../auth/session';
import { AppError, badRequest, parseInput, unauthorized } from '../lib/errors';
import { recordAudit } from '../lib/audit';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp';

const LOCK_THRESHOLD = 10;
const LOCK_MINUTES = 15;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-never-matches');
  return dummyHash;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: config.isTest ? 10000 : 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const input = parseInput(loginSchema, request.body);

      const { rows } = await getPool().query<{
        id: string;
        email: string | null;
        display_name: string;
        password_hash: string | null;
        status: 'invited' | 'active' | 'locked' | 'disabled';
        failed_login_attempts: number;
        locked_until: Date | null;
      }>(
        `SELECT id, email, display_name, password_hash, status, failed_login_attempts, locked_until
         FROM users WHERE lower(email) = lower($1)`,
        [input.email],
      );
      const user = rows[0];

      // Always run a hash comparison so response time does not reveal whether
      // the email exists.
      const matches = await verifyPassword(input.password, user?.password_hash ?? (await getDummyHash()));

      if (!user) {
        await recordAudit(getPool(), {
          action: 'auth.login',
          entityType: 'user',
          outcome: 'failure',
          reason: 'unknown email',
          sourceIp: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        throw unauthorized('Email or password is incorrect');
      }

      if (user.locked_until && user.locked_until.getTime() > Date.now()) {
        throw new AppError(
          423,
          'account_locked',
          'Too many failed attempts. Try again in a few minutes or contact your administrator.',
        );
      }

      if (!matches) {
        const attempts = user.failed_login_attempts + 1;
        const lockedUntil =
          attempts >= LOCK_THRESHOLD
            ? new Date(Date.now() + LOCK_MINUTES * 60_000)
            : user.locked_until;
        await getPool().query(
          `UPDATE users
           SET failed_login_attempts = $2,
               locked_until = $3
           WHERE id = $1`,
          [user.id, attempts, lockedUntil],
        );
        await recordAudit(getPool(), {
          schoolId: null,
          actorUserId: user.id,
          action: 'auth.login',
          entityType: 'user',
          entityId: user.id,
          outcome: 'failure',
          reason: 'invalid password',
          sourceIp: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        throw unauthorized('Email or password is incorrect');
      }

      if (user.status !== 'active') {
        throw new AppError(
          403,
          'account_unavailable',
          'This account is not active. Contact your school administrator.',
        );
      }

      const mfa = await getPool().query<{ secret: string }>(
        `SELECT secret FROM user_mfa WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
        [user.id],
      );
      const mfaSecret = mfa.rows[0]?.secret;
      if (mfaSecret) {
        if (!input.totpCode) {
          throw new AppError(
            401,
            'mfa_required',
            'Enter the 6-digit code from your authenticator app.',
          );
        }
        if (!verifyTotp(mfaSecret, input.totpCode)) {
          const attempts = user.failed_login_attempts + 1;
          const lockedUntil =
            attempts >= LOCK_THRESHOLD
              ? new Date(Date.now() + LOCK_MINUTES * 60_000)
              : user.locked_until;
          await getPool().query(
            `UPDATE users SET failed_login_attempts = $2, locked_until = $3 WHERE id = $1`,
            [user.id, attempts, lockedUntil],
          );
          await recordAudit(getPool(), {
            schoolId: null,
            actorUserId: user.id,
            action: 'auth.mfa_failed',
            entityType: 'user',
            entityId: user.id,
            outcome: 'failure',
            reason: 'invalid TOTP code',
            sourceIp: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });
          throw new AppError(401, 'invalid_totp', 'That authentication code is not valid.');
        }
        await getPool().query('UPDATE user_mfa SET last_used_at = now() WHERE user_id = $1', [
          user.id,
        ]);
      }

      await getPool().query(
        `UPDATE users
         SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now()
         WHERE id = $1`,
        [user.id],
      );

      const session = await createSession(user.id, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      reply.setCookie(SESSION_COOKIE, session.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        expires: session.expiresAt,
      });

      await recordAudit(getPool(), {
        actorUserId: user.id,
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        outcome: 'success',
        sourceIp: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      const memberships = await loadMemberships(user.id);
      const body: MeResponse = {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          status: user.status,
        },
        memberships,
      };
      return reply.send(body);
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.sessionToken) await revokeSession(request.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => {
    const user = request.user!;
    return {
      user,
      memberships: await loadMemberships(user.id),
    } satisfies MeResponse;
  });

  app.post(
    '/api/auth/change-password',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = parseInput(changePasswordSchema, request.body);
      const user = request.user!;

      const { rows } = await getPool().query<{ password_hash: string | null }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [user.id],
      );
      const ok = await verifyPassword(input.currentPassword, rows[0]?.password_hash ?? null);
      if (!ok) throw unauthorized('Current password is incorrect');

      const nextHash = await hashPassword(input.newPassword);
      await withTransaction(async (client) => {
        await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
          user.id,
          nextHash,
        ]);
        // Invalidate every other session after a password change.
        await client.query(
          `UPDATE sessions SET revoked_at = now()
           WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2`,
          [user.id, request.sessionToken ?? ''],
        );
        await recordAudit(client, {
          actorUserId: user.id,
          action: 'auth.password_changed',
          entityType: 'user',
          entityId: user.id,
          outcome: 'success',
          sourceIp: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      });

      return reply.status(204).send();
    },
  );

  /* ----------------------------- password reset ---------------------------- */

  app.post(
    '/api/auth/password/forgot',
    { config: { rateLimit: { max: config.isTest ? 10000 : 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = parseInput(passwordForgotSchema, request.body);
      const { rows } = await getPool().query<{ id: string; status: string }>(
        `SELECT id, status FROM users WHERE lower(email) = lower($1)`,
        [input.email],
      );
      const user = rows[0];

      let devToken: string | undefined;
      if (user && user.status !== 'disabled') {
        const token = randomBytes(32).toString('base64url');
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE password_reset_tokens SET used_at = now()
             WHERE user_id = $1 AND used_at IS NULL`,
            [user.id],
          );
          await client.query(
            `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
             VALUES ($1, $2, now() + interval '30 minutes', $3)`,
            [user.id, hashToken(token), request.ip ?? null],
          );
          await recordAudit(client, {
            actorUserId: user.id,
            action: 'auth.password_reset_requested',
            entityType: 'user',
            entityId: user.id,
            outcome: 'success',
            sourceIp: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });
        });
        // Email delivery is not configured in this build. Outside production the
        // token is returned so the flow can be completed and tested; in
        // production an administrator must deliver it out of band.
        if (!config.isProduction) devToken = token;
      }

      return reply.status(202).send({
        delivered: false,
        message:
          'If that account exists, a reset link has been created. Email delivery is not configured; ask an administrator to deliver it.',
        ...(devToken ? { devToken } : {}),
      });
    },
  );

  app.post(
    '/api/auth/password/reset',
    { config: { rateLimit: { max: config.isTest ? 10000 : 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = parseInput(passwordResetSchema, request.body);
      const nextHash = await hashPassword(input.newPassword);

      await withTransaction(async (client) => {
        const { rows } = await client.query<{
          id: string;
          user_id: string;
          expires_at: Date;
          used_at: Date | null;
          status: string;
        }>(
          `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.status
           FROM password_reset_tokens t
           JOIN users u ON u.id = t.user_id
           WHERE t.token_hash = $1
           FOR UPDATE`,
          [hashToken(input.token)],
        );
        const token = rows[0];
        if (!token || token.used_at || token.expires_at.getTime() <= Date.now()) {
          throw badRequest('This reset link is invalid or has expired');
        }
        if (token.status === 'disabled') {
          throw badRequest('This account is disabled. Contact your school administrator.');
        }

        await client.query(
          `UPDATE users
           SET password_hash = $2, failed_login_attempts = 0, locked_until = NULL
           WHERE id = $1`,
          [token.user_id, nextHash],
        );
        await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [
          token.id,
        ]);
        await client.query(
          `UPDATE password_reset_tokens SET used_at = now()
           WHERE user_id = $1 AND used_at IS NULL`,
          [token.user_id],
        );
        await client.query(
          'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
          [token.user_id],
        );
        await recordAudit(client, {
          actorUserId: token.user_id,
          action: 'auth.password_reset_completed',
          entityType: 'user',
          entityId: token.user_id,
          outcome: 'success',
          sourceIp: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      });

      return reply.status(204).send();
    },
  );

  /* ---------------------------------- MFA ---------------------------------- */

  app.get('/api/auth/mfa', { preHandler: requireAuth }, async (request) => {
    const { rows } = await getPool().query<{ confirmed_at: Date | null }>(
      'SELECT confirmed_at FROM user_mfa WHERE user_id = $1',
      [request.user!.id],
    );
    return {
      enabled: Boolean(rows[0]?.confirmed_at),
      configured: Boolean(rows[0]),
      confirmedAt: rows[0]?.confirmed_at ? rows[0]!.confirmed_at.toISOString() : null,
    };
  });

  app.post(
    '/api/auth/mfa/setup',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request) => {
      const user = request.user!;
      const existing = await getPool().query<{ confirmed_at: Date | null }>(
        'SELECT confirmed_at FROM user_mfa WHERE user_id = $1',
        [user.id],
      );
      if (existing.rows[0]?.confirmed_at) {
        throw new AppError(
          409,
          'mfa_already_enabled',
          'Two-factor authentication is already enabled for this account.',
        );
      }

      const secret = generateTotpSecret();
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO user_mfa (user_id, secret, confirmed_at)
           VALUES ($1, $2, NULL)
           ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, confirmed_at = NULL`,
          [user.id, secret],
        );
        await recordAudit(client, {
          actorUserId: user.id,
          action: 'auth.mfa_setup_started',
          entityType: 'user',
          entityId: user.id,
          outcome: 'success',
          sourceIp: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      });

      return {
        secret,
        otpauthUrl: otpauthUrl(user.email ?? user.displayName, secret),
      };
    },
  );

  app.post(
    '/api/auth/mfa/enable',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const user = request.user!;
      const input = parseInput(mfaCodeSchema, request.body);
      const { rows } = await getPool().query<{ secret: string; confirmed_at: Date | null }>(
        'SELECT secret, confirmed_at FROM user_mfa WHERE user_id = $1',
        [user.id],
      );
      const mfa = rows[0];
      if (!mfa) throw badRequest('Start two-factor setup first');
      if (!verifyTotp(mfa.secret, input.code)) {
        throw badRequest('That authentication code is not valid', {
          code: ['Check the code and try again'],
        });
      }
      await withTransaction(async (client) => {
        await client.query(
          'UPDATE user_mfa SET confirmed_at = COALESCE(confirmed_at, now()) WHERE user_id = $1',
          [user.id],
        );
        await recordAudit(client, {
          actorUserId: user.id,
          action: 'auth.mfa_enabled',
          entityType: 'user',
          entityId: user.id,
          outcome: 'success',
          sourceIp: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/auth/mfa/disable',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const user = request.user!;
      const input = parseInput(mfaDisableSchema, request.body);
      const { rows } = await getPool().query<{ password_hash: string | null; secret: string }>(
        `SELECT u.password_hash, m.secret
         FROM users u LEFT JOIN user_mfa m ON m.user_id = u.id AND m.confirmed_at IS NOT NULL
         WHERE u.id = $1`,
        [user.id],
      );
      const row = rows[0];
      const passwordOk = await verifyPassword(input.password, row?.password_hash ?? null);
      if (!passwordOk) throw unauthorized('Your password is not correct');
      if (!row?.secret) throw badRequest('Two-factor authentication is not enabled');
      if (!verifyTotp(row.secret, input.code)) {
        throw badRequest('That authentication code is not valid', {
          code: ['Check the code and try again'],
        });
      }

      await withTransaction(async (client) => {
        await client.query('DELETE FROM user_mfa WHERE user_id = $1', [user.id]);
        await recordAudit(client, {
          actorUserId: user.id,
          action: 'auth.mfa_disabled',
          entityType: 'user',
          entityId: user.id,
          outcome: 'success',
          sourceIp: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      });
      return reply.status(204).send();
    },
  );
}
