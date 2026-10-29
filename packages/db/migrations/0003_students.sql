-- 0003 Students, guardians, admissions and enrollments.

-- Per-school monotonic counters (admission numbers, receipt numbers later).
CREATE TABLE school_counters (
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name VARCHAR(60) NOT NULL,
  value BIGINT NOT NULL DEFAULT 0 CHECK (value >= 0),
  PRIMARY KEY (school_id, name)
);

CREATE TABLE students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  admission_number VARCHAR(60) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  middle_name VARCHAR(100),
  last_name VARCHAR(100),
  date_of_birth DATE,
  status VARCHAR(30) NOT NULL DEFAULT 'applicant'
    CHECK (status IN ('applicant', 'active', 'withdrawn', 'graduated', 'transferred', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_students_school_admission UNIQUE (school_id, admission_number),
  CONSTRAINT uq_students_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_students_admission CHECK (length(btrim(admission_number)) > 0),
  CONSTRAINT chk_students_names CHECK (length(btrim(first_name)) > 0)
);
CREATE TRIGGER trg_students_updated_at BEFORE UPDATE ON students
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX ix_students_school_status ON students (school_id, status, admission_number);
CREATE INDEX ix_students_school_name ON students (school_id, lower(last_name), lower(first_name));

CREATE TABLE guardians (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100),
  email VARCHAR(320),
  phone VARCHAR(40),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'unverified')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_guardians_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_guardians_contact CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CONSTRAINT chk_guardians_name CHECK (length(btrim(first_name)) > 0)
);
CREATE TRIGGER trg_guardians_updated_at BEFORE UPDATE ON guardians
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX ix_guardians_school_email ON guardians (school_id, lower(email));
CREATE INDEX ix_guardians_user ON guardians (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE student_guardians (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL,
  guardian_id UUID NOT NULL,
  relationship_type VARCHAR(40) NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  portal_access_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (portal_access_status IN ('pending', 'verified', 'revoked')),
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_student_guardians_pair UNIQUE (student_id, guardian_id),
  CONSTRAINT fk_student_guardians_student
    FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_student_guardians_guardian
    FOREIGN KEY (school_id, guardian_id) REFERENCES guardians(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_student_guardians_dates CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX ix_student_guardians_guardian
  ON student_guardians (guardian_id, portal_access_status);
CREATE INDEX ix_student_guardians_school_student
  ON student_guardians (school_id, student_id);

CREATE TABLE enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL,
  academic_year_id UUID NOT NULL,
  class_id UUID NOT NULL,
  section_id UUID NOT NULL,
  enrollment_status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (enrollment_status IN ('active', 'completed', 'transferred', 'withdrawn', 'cancelled')),
  starts_on DATE NOT NULL,
  ends_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_enrollments_student
    FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_enrollments_year
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_enrollments_section_same_year
    FOREIGN KEY (school_id, academic_year_id, class_id, section_id)
    REFERENCES sections(school_id, academic_year_id, class_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_enrollments_dates CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE TRIGGER trg_enrollments_updated_at BEFORE UPDATE ON enrollments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A student may be actively enrolled only once per academic year.
CREATE UNIQUE INDEX uq_enrollments_one_active_student_year
  ON enrollments (student_id, academic_year_id) WHERE enrollment_status = 'active';
CREATE INDEX ix_enrollments_school_section
  ON enrollments (school_id, section_id, enrollment_status);
CREATE INDEX ix_enrollments_school_student
  ON enrollments (school_id, student_id, academic_year_id);

-- Student attendance supports the next vertical slice; structure lands now so
-- section-based authorization can be built against it.
CREATE TABLE student_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL,
  enrollment_id UUID NOT NULL REFERENCES enrollments(id) ON DELETE RESTRICT,
  attendance_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL
    CHECK (status IN ('present', 'absent', 'late', 'half_day', 'excused', 'pending_review')),
  source VARCHAR(30) NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'import', 'device', 'correction')),
  recorded_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_student_attendance_student
    FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_attendance_enrollment_date UNIQUE (enrollment_id, attendance_date)
);
CREATE TRIGGER trg_student_attendance_updated_at BEFORE UPDATE ON student_attendance
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX ix_student_attendance_school_date
  ON student_attendance (school_id, attendance_date, status);

-- Unique key required by section-scoped foreign keys below.
ALTER TABLE sections
  ADD CONSTRAINT uq_sections_school_year_id UNIQUE (school_id, academic_year_id, id);

-- Teaching assignments drive teacher record scope. Populated in the academic
-- assignment slice; declared now so scope checks can be written against it.
CREATE TABLE teaching_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  academic_year_id UUID NOT NULL,
  section_id UUID NOT NULL,
  subject_id UUID,
  role VARCHAR(30) NOT NULL DEFAULT 'subject_teacher'
    CHECK (role IN ('class_teacher', 'subject_teacher')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_to DATE,
  CONSTRAINT uq_teaching_assignment UNIQUE (user_id, section_id, subject_id, role),
  CONSTRAINT fk_teaching_year
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_teaching_section
    FOREIGN KEY (school_id, academic_year_id, section_id)
    REFERENCES sections(school_id, academic_year_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_teaching_subject
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_teaching_dates CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX ix_teaching_user_section ON teaching_assignments (school_id, user_id, section_id);
