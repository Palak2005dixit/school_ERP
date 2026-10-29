-- 0011 Notice attachments and per-user read receipts.

CREATE TABLE notice_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  notice_id UUID NOT NULL,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(120) NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 1048576),
  data BYTEA NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_notice_attachments_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_notice_attachments_notice
    FOREIGN KEY (school_id, notice_id) REFERENCES notices(school_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_notice_attachments_filename CHECK (length(btrim(filename)) > 0)
);
CREATE INDEX ix_notice_attachments_notice
  ON notice_attachments (school_id, notice_id, created_at);

CREATE TABLE notice_receipts (
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  notice_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, notice_id, user_id),
  CONSTRAINT fk_notice_receipts_notice
    FOREIGN KEY (school_id, notice_id) REFERENCES notices(school_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_notice_receipts_school_user
  ON notice_receipts (school_id, user_id, read_at DESC);
