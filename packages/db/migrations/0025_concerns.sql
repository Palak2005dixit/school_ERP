-- 0025 Generic concerns, complaints, tasks and SLA tracking.
--
-- This is deliberately separate from safeguarding_cases. Safeguarding keeps its
-- own stricter permission and never appears in generic ticket lists, exports or
-- requester-visible notes. SLA hours are category configuration; overdue is
-- derived from sla_due_at rather than stored, so a policy change does not rewrite
-- history.

CREATE TABLE concern_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  default_priority VARCHAR(20) NOT NULL DEFAULT 'medium'
    CHECK (default_priority IN ('low', 'medium', 'high', 'urgent')),
  sla_hours INTEGER NOT NULL DEFAULT 24 CHECK (sla_hours BETWEEN 1 AND 8760),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT uq_concern_categories_school_code UNIQUE (school_id, code),
  CONSTRAINT uq_concern_categories_school_id_id UNIQUE (school_id, id)
);

CREATE TABLE concerns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  reference VARCHAR(40) NOT NULL,
  category_id UUID,
  subject VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  requester_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requester_name VARCHAR(200) NOT NULL,
  requester_email VARCHAR(320),
  student_id UUID,
  assigned_to UUID REFERENCES users(id) ON DELETE RESTRICT,
  priority VARCHAR(20) NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'waiting', 'resolved', 'closed', 'cancelled')),
  visibility VARCHAR(20) NOT NULL DEFAULT 'requester'
    CHECK (visibility IN ('internal', 'requester')),
  sla_due_at TIMESTAMPTZ NOT NULL,
  first_response_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution_summary TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_concerns_school_reference UNIQUE (school_id, reference),
  CONSTRAINT uq_concerns_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_concerns_category
    FOREIGN KEY (school_id, category_id) REFERENCES concern_categories(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_concerns_student
    FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_concerns_resolution
    CHECK ((status = 'resolved' AND resolved_at IS NOT NULL) OR status <> 'resolved')
);

CREATE TRIGGER trg_concerns_updated_at BEFORE UPDATE ON concerns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_concerns_queue
  ON concerns (school_id, status, priority, sla_due_at);
CREATE INDEX idx_concerns_requester
  ON concerns (school_id, requester_user_id, created_at DESC);

CREATE TABLE concern_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  concern_id UUID NOT NULL,
  event_type VARCHAR(30) NOT NULL
    CHECK (event_type IN ('created', 'assigned', 'status_changed', 'note_added', 'escalated', 'resolved', 'reopened', 'attachment_added')),
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note TEXT,
  is_internal BOOLEAN NOT NULL DEFAULT TRUE,
  from_status VARCHAR(20),
  to_status VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_concern_events_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_concern_events_concern
    FOREIGN KEY (school_id, concern_id) REFERENCES concerns(school_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_concern_events_timeline
  ON concern_events (school_id, concern_id, created_at);

CREATE TABLE concern_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  concern_id UUID NOT NULL,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(120) NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 1048576),
  data BYTEA NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  is_internal BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_concern_attachments_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_concern_attachments_concern
    FOREIGN KEY (school_id, concern_id) REFERENCES concerns(school_id, id) ON DELETE RESTRICT
);
