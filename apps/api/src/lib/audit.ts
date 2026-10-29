import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface AuditInput {
  schoolId?: string | null;
  actorUserId?: string | null;
  actorType?: 'user' | 'system' | 'integration';
  action: string;
  entityType: string;
  entityId?: string | null;
  outcome: 'success' | 'denied' | 'failure' | 'system';
  reason?: string | null;
  correlationId?: string | null;
  before?: unknown;
  after?: unknown;
  sourceIp?: string | null;
  userAgent?: string | null;
}

/**
 * Append-only audit record. Called inside the same transaction as the mutation
 * it describes so a committed change can never exist without its evidence.
 * Never pass secrets or full documents in before/after.
 */
export async function recordAudit(client: Queryable, input: AuditInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (school_id, actor_user_id, actor_type, action, entity_type, entity_id, outcome,
        reason, correlation_id, before_state, after_state, source_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      input.schoolId ?? null,
      input.actorUserId ?? null,
      input.actorType ?? 'user',
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.outcome,
      input.reason ?? null,
      input.correlationId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.sourceIp ?? null,
      input.userAgent ?? null,
    ],
  );
}

export interface ActivityInput {
  schoolId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  actorUserId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

/** Human-readable timeline entry shown on record detail screens. */
export async function recordActivity(client: Queryable, input: ActivityInput): Promise<void> {
  await client.query(
    `INSERT INTO activity_events
       (school_id, entity_type, entity_id, event_type, actor_user_id, summary, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.schoolId,
      input.entityType,
      input.entityId,
      input.eventType,
      input.actorUserId ?? null,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}
