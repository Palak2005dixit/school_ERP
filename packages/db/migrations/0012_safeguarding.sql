-- 0012 Safeguarding cases and restricted notes.
--
-- Access is gated by `safeguarding.case.view`; notes are never exposed through
-- generic student queries and every mutation is audited without copying note
-- text into the audit payload.

CREATE TABLE safeguarding_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL,
  reference VARCHAR(32) NOT NULL,
  category VARCHAR(40) NOT NULL
    CHECK (category IN ('safeguarding', 'attendance', 'wellbeing', 'medical', 'behaviour', 'other')),
  severity VARCHAR(20) NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  summary TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'monitoring', 'closed')),
  opened_on DATE NOT NULL DEFAULT current_date,
  closed_on DATE,
  opened_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_safeguarding_cases_school_ref UNIQUE (school_id, reference),
  CONSTRAINT uq_safeguarding_cases_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_safeguarding_cases_summary CHECK (length(btrim(summary)) >= 10),
  CONSTRAINT chk_safeguarding_cases_closed CHECK (
    (status = 'closed' AND closed_on IS NOT NULL)
    OR (status <> 'closed')
  ),
  CONSTRAINT fk_safeguarding_cases_student
    FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_safeguarding_cases_updated_at BEFORE UPDATE ON safeguarding_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX ix_safeguarding_cases_school_status
  ON safeguarding_cases (school_id, status, opened_on DESC);

CREATE TABLE safeguarding_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  case_id UUID NOT NULL,
  note TEXT NOT NULL,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_safeguarding_notes_note CHECK (length(btrim(note)) >= 1),
  CONSTRAINT fk_safeguarding_notes_case
    FOREIGN KEY (school_id, case_id) REFERENCES safeguarding_cases(school_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_safeguarding_notes_case
  ON safeguarding_notes (school_id, case_id, created_at);
