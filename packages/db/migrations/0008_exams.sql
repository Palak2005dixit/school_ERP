-- 0008 Examinations: configurable grading, exams, subjects and marks.
--
-- Grading bands are data, not code. The seed proposes a common Indian
-- 8-point band set, but a school can edit it; nothing in the schema assumes it.
-- Results become visible to guardians only after an authorized user publishes
-- the exam.

CREATE TABLE grading_schemes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_grading_schemes_school_code UNIQUE (school_id, code),
  CONSTRAINT uq_grading_schemes_school_id_id UNIQUE (school_id, id)
);
CREATE UNIQUE INDEX uq_grading_schemes_one_default
  ON grading_schemes (school_id) WHERE is_default;
CREATE TRIGGER trg_grading_schemes_updated_at BEFORE UPDATE ON grading_schemes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE grading_bands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  scheme_id UUID NOT NULL,
  min_percent NUMERIC(5, 2) NOT NULL CHECK (min_percent >= 0 AND min_percent <= 100),
  max_percent NUMERIC(5, 2) NOT NULL CHECK (max_percent >= 0 AND max_percent <= 100),
  grade VARCHAR(10) NOT NULL,
  remark VARCHAR(120),
  CONSTRAINT chk_grading_bands_range CHECK (max_percent >= min_percent),
  CONSTRAINT uq_grading_bands_scheme_grade UNIQUE (scheme_id, grade),
  CONSTRAINT fk_grading_bands_scheme
    FOREIGN KEY (school_id, scheme_id) REFERENCES grading_schemes(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE exams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  academic_year_id UUID NOT NULL,
  name VARCHAR(120) NOT NULL,
  exam_type VARCHAR(40) NOT NULL DEFAULT 'term',
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  grading_scheme_id UUID NOT NULL,
  pass_percent NUMERIC(5, 2) NOT NULL DEFAULT 35 CHECK (pass_percent >= 0 AND pass_percent <= 100),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at TIMESTAMPTZ,
  published_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_exams_year_name UNIQUE (academic_year_id, name),
  CONSTRAINT uq_exams_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_exams_dates CHECK (ends_on >= starts_on),
  CONSTRAINT chk_exams_published CHECK (
    (status = 'draft' AND published_at IS NULL AND published_by IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL AND published_by IS NOT NULL)
  ),
  CONSTRAINT fk_exams_year
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_exams_scheme
    FOREIGN KEY (school_id, grading_scheme_id) REFERENCES grading_schemes(school_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_exams_updated_at BEFORE UPDATE ON exams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE exam_subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  exam_id UUID NOT NULL,
  subject_id UUID NOT NULL,
  max_marks NUMERIC(6, 2) NOT NULL CHECK (max_marks > 0),
  pass_marks NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (pass_marks >= 0),
  CONSTRAINT uq_exam_subjects_pair UNIQUE (exam_id, subject_id),
  CONSTRAINT uq_exam_subjects_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_exam_subjects_pass CHECK (pass_marks <= max_marks),
  CONSTRAINT fk_exam_subjects_exam
    FOREIGN KEY (school_id, exam_id) REFERENCES exams(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_exam_subjects_subject
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE exam_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  exam_subject_id UUID NOT NULL,
  student_id UUID NOT NULL,
  marks_obtained NUMERIC(6, 2) CHECK (marks_obtained IS NULL OR marks_obtained >= 0),
  is_absent BOOLEAN NOT NULL DEFAULT false,
  entered_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_exam_marks_student_subject UNIQUE (exam_subject_id, student_id),
  CONSTRAINT uq_exam_marks_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_exam_marks_value CHECK (
    (is_absent AND marks_obtained IS NULL)
    OR (NOT is_absent AND marks_obtained IS NOT NULL)
  ),
  CONSTRAINT fk_exam_marks_exam_subject
    FOREIGN KEY (school_id, exam_subject_id) REFERENCES exam_subjects(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_exam_marks_student
    FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_exam_marks_updated_at BEFORE UPDATE ON exam_marks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX ix_exam_marks_school_student ON exam_marks (school_id, student_id);
