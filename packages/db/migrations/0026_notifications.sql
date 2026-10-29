-- 0026 Notifications: in-app inbox, outbox and delivery preferences.
--
-- External delivery is provider-dependent. The outbox records what was queued
-- and every attempt; a message is only marked sent after a provider confirms it.
-- With no provider configured the row ends as blocked, never as sent. Consent is
-- stored per channel and checked before an external message is queued.

CREATE TABLE notification_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(60) NOT NULL,
  channel VARCHAR(20) NOT NULL
    CHECK (channel IN ('email', 'sms', 'inapp', 'whatsapp')),
  subject VARCHAR(200),
  body TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_notification_templates_school_code_channel UNIQUE (school_id, code, channel),
  CONSTRAINT uq_notification_templates_school_id_id UNIQUE (school_id, id)
);

CREATE TRIGGER trg_notification_templates_updated_at BEFORE UPDATE ON notification_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE in_app_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  link VARCHAR(500),
  category VARCHAR(40) NOT NULL DEFAULT 'general',
  dedupe_key VARCHAR(120),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_in_app_notifications_school_id_id UNIQUE (school_id, id)
);

CREATE UNIQUE INDEX uq_in_app_notifications_dedupe
  ON in_app_notifications (school_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_in_app_notifications_inbox
  ON in_app_notifications (school_id, user_id, read_at, created_at DESC);

CREATE TABLE notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  channel VARCHAR(20) NOT NULL
    CHECK (channel IN ('email', 'sms', 'inapp', 'whatsapp')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  consent_given_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_notification_preferences_school_user_channel UNIQUE (school_id, user_id, channel),
  CONSTRAINT chk_notification_preferences_consent
    CHECK (channel = 'inapp' OR enabled = FALSE OR consent_given_at IS NOT NULL)
);

CREATE TABLE notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  channel VARCHAR(20) NOT NULL
    CHECK (channel IN ('email', 'sms', 'whatsapp')),
  recipient_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  recipient_address VARCHAR(320) NOT NULL,
  template_code VARCHAR(60),
  subject VARCHAR(200),
  body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'sent', 'failed', 'blocked', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  provider VARCHAR(60),
  provider_message_id VARCHAR(200),
  dedupe_key VARCHAR(120),
  created_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT uq_notification_outbox_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_notification_outbox_sent
    CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_notification_outbox_dedupe
  ON notification_outbox (school_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_notification_outbox_queue
  ON notification_outbox (school_id, status, next_attempt_at);

CREATE TRIGGER trg_notification_outbox_updated_at BEFORE UPDATE ON notification_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notification_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  outbox_id UUID NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('sent', 'failed', 'blocked')),
  provider VARCHAR(60),
  error TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_notification_attempts_school_id_id UNIQUE (school_id, id),
  CONSTRAINT uq_notification_attempts_number UNIQUE (school_id, outbox_id, attempt_no),
  CONSTRAINT fk_notification_attempts_outbox
    FOREIGN KEY (school_id, outbox_id) REFERENCES notification_outbox(school_id, id) ON DELETE CASCADE
);
