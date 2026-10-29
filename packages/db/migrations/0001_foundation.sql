-- 0001 Foundation: tenancy, identity, RBAC, sessions, audit.
-- School ERP | PostgreSQL 14+ compatible (local embedded PG 18, Supabase PG 15+).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Kolkata',
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_schools_name CHECK (length(btrim(name)) > 0)
);
CREATE TRIGGER trg_schools_updated_at BEFORE UPDATE ON schools
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE campuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(200) NOT NULL,
  address JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_campuses_school_code UNIQUE (school_id, code),
  CONSTRAINT uq_campuses_school_id_id UNIQUE (school_id, id)
);
CREATE TRIGGER trg_campuses_updated_at BEFORE UPDATE ON campuses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  campus_id UUID,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_departments_campus_same_school
    FOREIGN KEY (school_id, campus_id) REFERENCES campuses(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_departments_school_code UNIQUE (school_id, code)
);
CREATE TRIGGER trg_departments_updated_at BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Identity is global; school access is granted through role assignments.
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(320),
  phone VARCHAR(40),
  display_name VARCHAR(200) NOT NULL,
  password_hash TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'active', 'locked', 'disabled')),
  failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_users_identity CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CONSTRAINT chk_users_display_name CHECK (length(btrim(display_name)) > 0)
);
CREATE UNIQUE INDEX uq_users_email_ci ON users (lower(email)) WHERE email IS NOT NULL;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  privileged_flag BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(100) NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_role_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  scope_type VARCHAR(30) NOT NULL
    CHECK (scope_type IN ('school', 'campus', 'department', 'class', 'section', 'self', 'linked_student', 'custom')),
  scope_id UUID,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  granted_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_assignment_dates CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT chk_assignment_scope CHECK (
    (scope_type IN ('school', 'self', 'linked_student') AND scope_id IS NULL)
    OR (scope_type IN ('campus', 'department', 'class', 'section', 'custom') AND scope_id IS NOT NULL)
  )
);
CREATE INDEX ix_role_assignments_user_active
  ON user_role_assignments (user_id, school_id, valid_from, valid_to)
  WHERE revoked_at IS NULL;
CREATE INDEX ix_role_assignments_school_scope
  ON user_role_assignments (school_id, scope_type, scope_id);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash CHAR(64) NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip INET,
  user_agent TEXT,
  CONSTRAINT chk_sessions_expiry CHECK (expires_at > created_at)
);
CREATE INDEX ix_sessions_user ON sessions (user_id, expires_at DESC);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID REFERENCES schools(id) ON DELETE RESTRICT,
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  actor_type VARCHAR(30) NOT NULL DEFAULT 'user'
    CHECK (actor_type IN ('user', 'system', 'integration')),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id UUID,
  outcome VARCHAR(30) NOT NULL CHECK (outcome IN ('success', 'denied', 'failure', 'system')),
  reason TEXT,
  correlation_id UUID,
  before_state JSONB,
  after_state JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_ip INET,
  user_agent TEXT
);
CREATE INDEX ix_audit_events_scope_time ON audit_events (school_id, occurred_at DESC);
CREATE INDEX ix_audit_events_entity ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX ix_audit_events_actor ON audit_events (actor_user_id, occurred_at DESC);

CREATE TABLE activity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  entity_type VARCHAR(100) NOT NULL,
  entity_id UUID NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_activity_entity_time
  ON activity_events (school_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX ix_activity_school_time
  ON activity_events (school_id, occurred_at DESC);

-- Audit history is append-only. Corrections are new events, never edits.
CREATE OR REPLACE FUNCTION forbid_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit and activity history is append-only';
END;
$$;

CREATE TRIGGER trg_audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_history_mutation();
CREATE TRIGGER trg_activity_events_immutable
  BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_history_mutation();
