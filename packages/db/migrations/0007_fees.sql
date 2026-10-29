-- 0007 Fees: heads, class-wise structures, student charges, payments and refunds.
--
-- Money is NUMERIC(12,2) throughout; no floating point. A charge's balance is
-- always derived from recorded payments minus approved refunds, so stored
-- status cannot drift from the ledger.

CREATE TABLE fee_heads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fee_heads_school_code UNIQUE (school_id, code),
  CONSTRAINT uq_fee_heads_school_id_id UNIQUE (school_id, id)
);
CREATE TRIGGER trg_fee_heads_updated_at BEFORE UPDATE ON fee_heads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE fee_structures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  academic_year_id UUID NOT NULL,
  class_id UUID NOT NULL,
  fee_head_id UUID NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  due_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fee_structures_year_class_head UNIQUE (academic_year_id, class_id, fee_head_id),
  CONSTRAINT uq_fee_structures_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_fee_structures_year
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fee_structures_class
    FOREIGN KEY (school_id, class_id) REFERENCES classes(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fee_structures_head
    FOREIGN KEY (school_id, fee_head_id) REFERENCES fee_heads(school_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_fee_structures_updated_at BEFORE UPDATE ON fee_structures
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE student_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL,
  academic_year_id UUID NOT NULL,
  fee_head_id UUID NOT NULL,
  description VARCHAR(200) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  concession_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (concession_amount >= 0),
  concession_reason TEXT,
  due_on DATE NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_student_charges_student_year_head UNIQUE (student_id, academic_year_id, fee_head_id),
  CONSTRAINT uq_student_charges_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_student_charges_concession CHECK (concession_amount <= amount),
  CONSTRAINT fk_student_charges_student
    FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_student_charges_year
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_student_charges_head
    FOREIGN KEY (school_id, fee_head_id) REFERENCES fee_heads(school_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_student_charges_updated_at BEFORE UPDATE ON student_charges
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX ix_student_charges_school_student
  ON student_charges (school_id, student_id, academic_year_id);
CREATE INDEX ix_student_charges_year_due
  ON student_charges (school_id, academic_year_id, due_on);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL,
  academic_year_id UUID NOT NULL,
  receipt_number VARCHAR(40) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  method VARCHAR(30) NOT NULL
    CHECK (method IN ('cash', 'bank_transfer', 'card', 'upi', 'cheque', 'other')),
  reference VARCHAR(120),
  paid_on DATE NOT NULL,
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'reversed')),
  recorded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reversed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_payments_school_receipt UNIQUE (school_id, receipt_number),
  CONSTRAINT uq_payments_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_payments_reversal CHECK (
    (status = 'recorded' AND reversed_by IS NULL AND reversed_at IS NULL)
    OR (status = 'reversed' AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL)
  ),
  CONSTRAINT fk_payments_student
    FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_payments_year
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT
);
CREATE INDEX ix_payments_school_student ON payments (school_id, student_id, paid_on DESC);
CREATE INDEX ix_payments_school_status ON payments (school_id, status, paid_on DESC);

CREATE TABLE payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  payment_id UUID NOT NULL,
  charge_id UUID NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_allocations_pair UNIQUE (payment_id, charge_id),
  CONSTRAINT fk_payment_allocations_payment
    FOREIGN KEY (school_id, payment_id) REFERENCES payments(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_payment_allocations_charge
    FOREIGN KEY (school_id, charge_id) REFERENCES student_charges(school_id, id) ON DELETE RESTRICT
);
CREATE INDEX ix_payment_allocations_charge ON payment_allocations (charge_id);

CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  payment_id UUID NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  CONSTRAINT chk_refunds_reason CHECK (length(btrim(reason)) >= 5),
  CONSTRAINT chk_refunds_review CHECK (
    (status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status IN ('approved', 'rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT fk_refunds_payment
    FOREIGN KEY (school_id, payment_id) REFERENCES payments(school_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_refunds_pending_payment
  ON refunds (payment_id) WHERE status = 'pending';
CREATE INDEX ix_refunds_school_status ON refunds (school_id, status, requested_at);
