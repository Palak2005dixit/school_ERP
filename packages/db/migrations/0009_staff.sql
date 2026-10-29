-- 0009 Staff records, salary (separately gated) and leave requests.

CREATE TABLE staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  employee_number VARCHAR(40) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100),
  email VARCHAR(320),
  phone VARCHAR(40),
  designation VARCHAR(120) NOT NULL,
  department VARCHAR(120),
  joined_on DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'on_leave', 'inactive', 'left')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_staff_school_employee UNIQUE (school_id, employee_number),
  CONSTRAINT uq_staff_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_staff_name CHECK (length(btrim(first_name)) > 0)
);
CREATE UNIQUE INDEX uq_staff_school_user ON staff (school_id, user_id) WHERE user_id IS NOT NULL;
CREATE TRIGGER trg_staff_updated_at BEFORE UPDATE ON staff
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Salary lives in its own table so list queries never join it accidentally.
CREATE TABLE staff_salaries (
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  staff_id UUID NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  effective_from DATE NOT NULL,
  notes TEXT,
  updated_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, staff_id),
  CONSTRAINT fk_staff_salaries_staff
    FOREIGN KEY (school_id, staff_id) REFERENCES staff(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  staff_id UUID NOT NULL,
  leave_type VARCHAR(40) NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  CONSTRAINT uq_leave_requests_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_leave_requests_dates CHECK (ends_on >= starts_on),
  CONSTRAINT chk_leave_requests_reason CHECK (length(btrim(reason)) >= 5),
  CONSTRAINT chk_leave_requests_review CHECK (
    (status IN ('pending', 'cancelled') AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status IN ('approved', 'rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT fk_leave_requests_staff
    FOREIGN KEY (school_id, staff_id) REFERENCES staff(school_id, id) ON DELETE RESTRICT
);
CREATE INDEX ix_leave_requests_school_status ON leave_requests (school_id, status, starts_on);
CREATE INDEX ix_leave_requests_staff ON leave_requests (school_id, staff_id, starts_on DESC);
