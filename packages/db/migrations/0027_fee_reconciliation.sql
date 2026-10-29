-- 0027 Fee reconciliation, concessions and write-offs.
--
-- A charge's collectable amount is now amount - concession_amount -
-- write_off_amount. Every code path that derives a balance must subtract all
-- three; the column default keeps existing rows correct. Write-offs are only
-- written through the API, which records an evidence row in fee_write_offs and
-- an audit event in the same transaction.
--
-- Bank/UPI statement reconciliation is an offline review workflow: imported
-- lines are matched to recorded payments by the finance user. The system never
-- claims a payment was received from a statement alone.

ALTER TABLE student_charges
  ADD COLUMN write_off_amount NUMERIC(12, 2) NOT NULL DEFAULT 0
    CHECK (write_off_amount >= 0);

ALTER TABLE student_charges
  ADD CONSTRAINT chk_student_charges_collectable
  CHECK (concession_amount + write_off_amount <= amount);

CREATE TABLE fee_concession_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL,
  academic_year_id UUID NOT NULL,
  charge_id UUID NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  CONSTRAINT uq_fee_concession_requests_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_fee_concession_requests_student
    FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fee_concession_requests_year
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fee_concession_requests_charge
    FOREIGN KEY (school_id, charge_id) REFERENCES student_charges(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_fee_concession_requests_reason CHECK (length(btrim(reason)) >= 5),
  CONSTRAINT chk_fee_concession_requests_review CHECK (
    (status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status IN ('approved', 'rejected', 'cancelled'))
  )
);

CREATE UNIQUE INDEX uq_fee_concession_requests_pending
  ON fee_concession_requests (school_id, charge_id)
  WHERE status = 'pending';
CREATE INDEX idx_fee_concession_requests_queue
  ON fee_concession_requests (school_id, status, requested_at);

CREATE TABLE fee_write_offs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  charge_id UUID NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  approved_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fee_write_offs_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_fee_write_offs_charge
    FOREIGN KEY (school_id, charge_id) REFERENCES student_charges(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_fee_write_offs_reason CHECK (length(btrim(reason)) >= 5)
);

CREATE INDEX idx_fee_write_offs_charge ON fee_write_offs (school_id, charge_id);

CREATE TABLE fee_reconciliation_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  reference VARCHAR(80) NOT NULL,
  source VARCHAR(60) NOT NULL DEFAULT 'bank_statement',
  statement_from DATE,
  statement_to DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'balanced', 'closed')),
  opening_balance NUMERIC(14, 2) CHECK (opening_balance IS NULL OR opening_balance >= 0),
  closing_balance NUMERIC(14, 2) CHECK (closing_balance IS NULL OR closing_balance >= 0),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  closed_at TIMESTAMPTZ,
  CONSTRAINT uq_fee_reconciliation_batches_school_reference
    UNIQUE (school_id, reference),
  CONSTRAINT uq_fee_reconciliation_batches_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_fee_reconciliation_batches_dates CHECK (
    statement_to IS NULL OR statement_from IS NULL OR statement_to >= statement_from
  ),
  CONSTRAINT chk_fee_reconciliation_batches_closed CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
  )
);

CREATE TRIGGER trg_fee_reconciliation_batches_updated_at
  BEFORE UPDATE ON fee_reconciliation_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE fee_reconciliation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  paid_on DATE NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount <> 0),
  reference VARCHAR(160),
  method VARCHAR(30) NOT NULL DEFAULT 'other'
    CHECK (method IN ('cash', 'bank_transfer', 'card', 'upi', 'cheque', 'other')),
  status VARCHAR(20) NOT NULL DEFAULT 'unmatched'
    CHECK (status IN ('unmatched', 'matched', 'exception')),
  matched_payment_id UUID,
  exception_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fee_reconciliation_lines_batch_no UNIQUE (school_id, batch_id, line_no),
  CONSTRAINT uq_fee_reconciliation_lines_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_fee_reconciliation_lines_batch
    FOREIGN KEY (school_id, batch_id) REFERENCES fee_reconciliation_batches(school_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_fee_reconciliation_lines_payment
    FOREIGN KEY (school_id, matched_payment_id) REFERENCES payments(school_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_fee_reconciliation_lines_match CHECK (
    (status = 'matched') = (matched_payment_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_fee_reconciliation_lines_payment
  ON fee_reconciliation_lines (school_id, matched_payment_id)
  WHERE matched_payment_id IS NOT NULL;
CREATE INDEX idx_fee_reconciliation_lines_batch
  ON fee_reconciliation_lines (school_id, batch_id, status);
