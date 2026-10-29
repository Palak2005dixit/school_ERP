import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { getPool } from '../db';
import { conflict } from './errors';

/**
 * Wraps a JSON mutation handler with idempotency-key replay.
 *
 * The first request with a given `Idempotency-Key` (per school, user and route)
 * claims a row; its completed response is stored and replayed verbatim for
 * later requests. Reusing a key for a different payload is rejected. The table
 * is keyed per route so the same key can be reused across unrelated actions.
 *
 * Routes that return HTML or streams should not be wrapped.
 */
export function idempotentRoute(
  route: string,
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    const header = request.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    const schoolId = (request.params as { schoolId?: string } | undefined)?.schoolId;
    const userId = request.user?.id;

    if (!key || !schoolId || !userId) return handler(request, reply);
    if (key.length > 120) throw conflict('Idempotency-Key is too long', 'idempotency_key_invalid');

    const requestHash = createHash('sha256')
      .update(JSON.stringify(request.body ?? null))
      .digest('hex');

    await getPool().query('DELETE FROM idempotency_keys WHERE expires_at < now()');

    const claim = await getPool().query(
      `INSERT INTO idempotency_keys (school_id, user_id, idempotency_key, route, request_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (school_id, user_id, idempotency_key, route) DO NOTHING
       RETURNING status`,
      [schoolId, userId, key, route, requestHash],
    );

    if (claim.rowCount === 0) {
      const { rows } = await getPool().query<{
        request_hash: string;
        status: string;
        response_status: number | null;
        response_body: unknown;
      }>(
        `SELECT request_hash, status, response_status, response_body
         FROM idempotency_keys
         WHERE school_id = $1 AND user_id = $2 AND idempotency_key = $3 AND route = $4`,
        [schoolId, userId, key, route],
      );
      const row = rows[0];
      if (!row) return handler(request, reply);
      if (row.request_hash !== requestHash) {
        throw conflict(
          'This Idempotency-Key was already used for a different request',
          'idempotency_mismatch',
        );
      }
      if (row.status !== 'completed' || row.response_status === null) {
        throw conflict('This request is already being processed', 'idempotency_in_progress');
      }
      return reply.status(row.response_status).send(row.response_body);
    }

    // Capture the payload the handler sends so the exact response can be
    // replayed without re-running side effects.
    let captured: unknown;
    let capturedStatus = 200;
    const originalSend = reply.send.bind(reply);
    reply.send = ((payload?: unknown) => {
      captured = payload;
      capturedStatus = reply.statusCode;
      return originalSend(payload as never);
    }) as FastifyReply['send'];

    try {
      const result = await handler(request, reply);
      const status = capturedStatus ?? reply.statusCode;
      const body = captured ?? result;
      await getPool().query(
        `UPDATE idempotency_keys
         SET status = 'completed', response_status = $5, response_body = $6
         WHERE school_id = $1 AND user_id = $2 AND idempotency_key = $3 AND route = $4`,
        [schoolId, userId, key, route, status, JSON.stringify(body ?? null)],
      );
      return result;
    } catch (error) {
      await getPool()
        .query(
          `DELETE FROM idempotency_keys
           WHERE school_id = $1 AND user_id = $2 AND idempotency_key = $3 AND route = $4`,
          [schoolId, userId, key, route],
        )
        .catch(() => undefined);
      throw error;
    }
  };
}
