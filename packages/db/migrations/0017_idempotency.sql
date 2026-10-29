-- 0017 Idempotency keys for money-moving and admission mutations.
--
-- A client supplies `Idempotency-Key`; the first completed response is replayed
-- for the same actor, route and key. Keys expire so the table cannot grow
-- without bound.

CREATE TABLE idempotency_keys (
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(120) NOT NULL,
  route VARCHAR(160) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed')),
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (school_id, user_id, idempotency_key, route)
);
CREATE INDEX ix_idempotency_keys_expiry ON idempotency_keys (expires_at);
