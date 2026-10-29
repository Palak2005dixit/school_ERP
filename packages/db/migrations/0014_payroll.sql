-- 0014 Payroll runs and payslips.
--
-- Amounts live only in these tables and are read through the salary-sensitive
-- permission. A run is approved by a different user from the one who created
-- it; the audit trail records counts, never amounts.

CREATE TABLE payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'paid')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  paid_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_payroll_runs_school_period UNIQUE (school_id, period_start, period_end),
  CONSTRAINT uq_payroll_runs_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_payroll_runs_dates CHECK (period_end >= period_start),
  CONSTRAINT chk_payroll_runs_approval CHECK (
    (status = 'draft' AND approved_by IS NULL AND approved_at IS NULL)
    OR (status IN ('approved', 'paid') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT chk_payroll_runs_paid CHECK (
    (status = 'paid' AND paid_on IS NOT NULL) OR (status <> 'paid')
  )
);
CREATE TRIGGER trg_payroll_runs_updated_at BEFORE UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payslips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  gross_amount NUMERIC(12, 2) NOT NULL CHECK (gross_amount >= 0),
  deductions NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (deductions >= 0),
  net_amount NUMERIC(12, 2) NOT NULL CHECK (net_amount >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_payslips_run_staff UNIQUE (school_id, run_id, staff_id),
  CONSTRAINT uq_payslips_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_payslips_net CHECK (net_amount = gross_amount - deductions),
  CONSTRAINT fk_payslips_run
    FOREIGN KEY (school_id, run_id) REFERENCES payroll_runs(school_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_payslips_staff
    FOREIGN KEY (school_id, staff_id) REFERENCES staff(school_id, id) ON DELETE RESTRICT
);
CREATE INDEX ix_payslips_school_staff ON payslips (school_id, staff_id);
