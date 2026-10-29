-- 0020 Recruitment, onboarding, employee changes and separation.
--
-- Candidate and offer data is personal and restricted: routes require the
-- recruitment permissions and never copy contact details or salary into the
-- audit trail. An approved offer is the only path that creates a staff record,
-- and the candidate keeps a link to the created employee to prevent duplicates.

CREATE TABLE vacancies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  reference VARCHAR(40) NOT NULL,
  title VARCHAR(160) NOT NULL,
  department VARCHAR(120),
  designation VARCHAR(120) NOT NULL,
  employment_type VARCHAR(30) NOT NULL DEFAULT 'full_time'
    CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'visiting')),
  openings INTEGER NOT NULL DEFAULT 1 CHECK (openings BETWEEN 1 AND 100),
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'open', 'closed', 'cancelled')),
  posted_on DATE,
  closes_on DATE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_vacancies_school_reference UNIQUE (school_id, reference),
  CONSTRAINT uq_vacancies_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_vacancies_dates CHECK (closes_on IS NULL OR posted_on IS NULL OR closes_on >= posted_on)
);

CREATE TRIGGER trg_vacancies_updated_at BEFORE UPDATE ON vacancies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_vacancies_status ON vacancies (school_id, status, posted_on DESC);

CREATE TABLE candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  vacancy_id UUID NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100),
  email VARCHAR(320) NOT NULL,
  phone VARCHAR(40),
  stage VARCHAR(20) NOT NULL DEFAULT 'applied'
    CHECK (stage IN ('applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn')),
  source VARCHAR(80),
  notes TEXT,
  applied_on DATE NOT NULL DEFAULT current_date,
  converted_staff_id UUID,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_candidates_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_candidates_vacancy
    FOREIGN KEY (school_id, vacancy_id) REFERENCES vacancies(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_candidates_staff
    FOREIGN KEY (school_id, converted_staff_id) REFERENCES staff(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_candidates_converted
    CHECK ((stage = 'hired') = (converted_staff_id IS NOT NULL))
);

CREATE UNIQUE INDEX uq_candidates_vacancy_email
  ON candidates (school_id, vacancy_id, lower(email));
CREATE INDEX idx_candidates_stage ON candidates (school_id, stage, applied_on DESC);

CREATE TRIGGER trg_candidates_updated_at BEFORE UPDATE ON candidates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE candidate_interviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  candidate_id UUID NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  mode VARCHAR(20) NOT NULL DEFAULT 'in_person'
    CHECK (mode IN ('in_person', 'phone', 'video')),
  interviewer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  score INTEGER CHECK (score BETWEEN 1 AND 10),
  recommendation VARCHAR(20)
    CHECK (recommendation IN ('strong_hire', 'hire', 'hold', 'reject')),
  feedback TEXT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_candidate_interviews_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_candidate_interviews_candidate
    FOREIGN KEY (school_id, candidate_id) REFERENCES candidates(school_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER trg_candidate_interviews_updated_at BEFORE UPDATE ON candidate_interviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_candidate_interviews_schedule
  ON candidate_interviews (school_id, scheduled_at);

CREATE TABLE job_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  candidate_id UUID NOT NULL,
  designation VARCHAR(120) NOT NULL,
  department VARCHAR(120),
  gross_salary NUMERIC(12, 2) NOT NULL CHECK (gross_salary > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  starts_on DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'accepted', 'declined', 'cancelled')),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_job_offers_school_id_id UNIQUE (school_id, id),
  CONSTRAINT uq_job_offers_candidate UNIQUE (school_id, candidate_id),
  CONSTRAINT fk_job_offers_candidate
    FOREIGN KEY (school_id, candidate_id) REFERENCES candidates(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_job_offers_approval
    CHECK (
      (status IN ('draft', 'pending_approval', 'cancelled') AND approved_by IS NULL AND approved_at IS NULL)
      OR (status IN ('approved', 'rejected', 'accepted', 'declined') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    )
);

CREATE TRIGGER trg_job_offers_updated_at BEFORE UPDATE ON job_offers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE onboarding_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  staff_id UUID NOT NULL,
  title VARCHAR(200) NOT NULL,
  owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  due_on DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'cancelled')),
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_onboarding_tasks_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_onboarding_tasks_staff
    FOREIGN KEY (school_id, staff_id) REFERENCES staff(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_onboarding_tasks_completed
    CHECK ((status = 'done') = (completed_at IS NOT NULL))
);

CREATE INDEX idx_onboarding_tasks_staff ON onboarding_tasks (school_id, staff_id, status);

CREATE TABLE employee_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  staff_id UUID NOT NULL,
  change_type VARCHAR(30) NOT NULL
    CHECK (change_type IN ('transfer', 'department', 'designation', 'status')),
  effective_on DATE NOT NULL,
  from_value VARCHAR(200),
  to_value VARCHAR(200) NOT NULL,
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_employee_changes_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_employee_changes_staff
    FOREIGN KEY (school_id, staff_id) REFERENCES staff(school_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_employee_changes_staff
  ON employee_changes (school_id, staff_id, effective_on DESC);

CREATE TABLE staff_separations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  staff_id UUID NOT NULL,
  last_working_day DATE NOT NULL,
  reason VARCHAR(30) NOT NULL
    CHECK (reason IN ('resignation', 'retirement', 'termination', 'contract_end', 'other')),
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'approved', 'completed', 'cancelled')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  access_revoked_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_staff_separations_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_staff_separations_staff
    FOREIGN KEY (school_id, staff_id) REFERENCES staff(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_staff_separations_approval
    CHECK (status IN ('initiated', 'cancelled') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT chk_staff_separations_completion
    CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

CREATE UNIQUE INDEX uq_staff_separations_open
  ON staff_separations (school_id, staff_id)
  WHERE status IN ('initiated', 'approved');

CREATE TRIGGER trg_staff_separations_updated_at BEFORE UPDATE ON staff_separations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE exit_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  separation_id UUID NOT NULL,
  title VARCHAR(200) NOT NULL,
  owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'cancelled')),
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_exit_tasks_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_exit_tasks_separation
    FOREIGN KEY (school_id, separation_id) REFERENCES staff_separations(school_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_exit_tasks_separation ON exit_tasks (school_id, separation_id, status);
