-- 0015 Fee late-fee rules, assessment log and instalment schedules.
--
-- Late fees are posted to a dedicated LATE-FEE head so the ordinary ledger
-- stays intact. Assessments are unique per charge per day, which makes a
-- re-run idempotent for the same day. Instalment schedules are derived views
-- of a charge; allocations remain charge-level.

CREATE TABLE fee_late_fee_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  name VARCHAR(120) NOT NULL,
  grace_days INTEGER NOT NULL DEFAULT 0 CHECK (grace_days >= 0 AND grace_days <= 365),
  percent_per_month NUMERIC(5, 2) NOT NULL DEFAULT 0
    CHECK (percent_per_month >= 0 AND percent_per_month <= 100),
  max_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (max_amount >= 0),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fee_late_fee_rules_school_id_id UNIQUE (school_id, id)
);
CREATE TRIGGER trg_fee_late_fee_rules_updated_at BEFORE UPDATE ON fee_late_fee_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE late_fee_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  charge_id UUID NOT NULL,
  rule_id UUID NOT NULL,
  assessed_on DATE NOT NULL,
  base_amount NUMERIC(12, 2) NOT NULL CHECK (base_amount >= 0),
  fee_amount NUMERIC(12, 2) NOT NULL CHECK (fee_amount >= 0),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_late_fee_assessments_charge_day UNIQUE (school_id, charge_id, assessed_on),
  CONSTRAINT fk_late_fee_assessments_charge
    FOREIGN KEY (school_id, charge_id) REFERENCES student_charges(school_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_late_fee_assessments_rule
    FOREIGN KEY (school_id, rule_id) REFERENCES fee_late_fee_rules(school_id, id) ON DELETE RESTRICT
);
CREATE INDEX ix_late_fee_assessments_school_day
  ON late_fee_assessments (school_id, assessed_on DESC);

CREATE TABLE fee_installment_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  structure_id UUID NOT NULL,
  sequence SMALLINT NOT NULL CHECK (sequence > 0),
  label VARCHAR(80) NOT NULL,
  percent NUMERIC(5, 2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  due_on DATE NOT NULL,
  CONSTRAINT uq_fee_installment_plans_structure_seq UNIQUE (school_id, structure_id, sequence),
  CONSTRAINT uq_fee_installment_plans_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_fee_installment_plans_structure
    FOREIGN KEY (school_id, structure_id) REFERENCES fee_structures(school_id, id) ON DELETE CASCADE
);
