-- Gateway events never silently post money into the existing fee ledger.
-- Verification and independent reconciliation remain distinct evidence.
CREATE TABLE payment_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id),
 student_id uuid NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9999999999),
 currency varchar(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), provider varchar(80), provider_reference varchar(200),
 checkout_url text, status varchar(20) NOT NULL DEFAULT 'blocked' CHECK(status IN('blocked','creating','pending','verified','failed','exception')),
 requested_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(school_id,id), UNIQUE(provider,provider_reference),
 FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id)
);
CREATE TABLE payment_gateway_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id),
 intent_id uuid NOT NULL, provider varchar(80) NOT NULL, event_id varchar(200) NOT NULL,
 payload_hash varchar(64) NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0), currency varchar(3) NOT NULL,
 event_state varchar(20) NOT NULL CHECK(event_state IN('captured','failed')),
 status varchar(20) NOT NULL CHECK(status IN('verified','exception','reconciled')),
 payment_id uuid, exception_reason text, received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,event_id), UNIQUE(school_id,payment_id),
 FOREIGN KEY(school_id,intent_id) REFERENCES payment_intents(school_id,id),
 FOREIGN KEY(school_id,payment_id) REFERENCES payments(school_id,id)
);
CREATE INDEX ix_payment_intents_school ON payment_intents(school_id,created_at DESC);
CREATE INDEX ix_gateway_events_queue ON payment_gateway_events(school_id,status,received_at DESC);
ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_intents USING(school_id=nullif(current_setting('app.school_id',true),'')::uuid) WITH CHECK(school_id=nullif(current_setting('app.school_id',true),'')::uuid);
ALTER TABLE payment_gateway_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_gateway_events USING(school_id=nullif(current_setting('app.school_id',true),'')::uuid) WITH CHECK(school_id=nullif(current_setting('app.school_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON payment_intents,payment_gateway_events TO erp_app;
