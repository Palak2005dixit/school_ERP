-- 0013 Leave types, holiday calendar and per-type balances.
--
-- Leave types are configuration, not code. Balances are derived from approved
-- requests in the selected calendar year; nothing is pre-aggregated.

CREATE TABLE leave_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  annual_quota_days NUMERIC(5, 1) NOT NULL DEFAULT 0 CHECK (annual_quota_days >= 0),
  paid BOOLEAN NOT NULL DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_leave_types_school_code UNIQUE (school_id, code),
  CONSTRAINT uq_leave_types_school_id_id UNIQUE (school_id, id)
);
CREATE TRIGGER trg_leave_types_updated_at BEFORE UPDATE ON leave_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  name VARCHAR(120) NOT NULL,
  holiday_on DATE NOT NULL,
  academic_year_id UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_holidays_school_date_name UNIQUE (school_id, holiday_on, name),
  CONSTRAINT uq_holidays_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_holidays_year
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_holidays_updated_at BEFORE UPDATE ON holidays
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX ix_holidays_school_date ON holidays (school_id, holiday_on);
