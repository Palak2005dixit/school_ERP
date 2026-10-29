-- 0002 Academic structure: years, terms, classes, sections, subjects.

CREATE TABLE academic_years (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(100) NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'active', 'closed', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_academic_years_school_code UNIQUE (school_id, code),
  CONSTRAINT uq_academic_years_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_academic_years_dates CHECK (ends_on >= starts_on)
);
CREATE TRIGGER trg_academic_years_updated_at BEFORE UPDATE ON academic_years
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- At most one active academic year per school. Activation happens in a
-- transaction that first closes the previous year.
CREATE UNIQUE INDEX uq_academic_years_one_active
  ON academic_years (school_id) WHERE status = 'active';

CREATE TABLE terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  academic_year_id UUID NOT NULL,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(100) NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_terms_year_code UNIQUE (academic_year_id, code),
  CONSTRAINT uq_terms_year_sequence UNIQUE (academic_year_id, sequence_no),
  CONSTRAINT chk_terms_dates CHECK (ends_on >= starts_on),
  CONSTRAINT fk_terms_year_same_school
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(100) NOT NULL,
  grade_order INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_classes_school_code UNIQUE (school_id, code),
  CONSTRAINT uq_classes_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_classes_grade_order CHECK (grade_order IS NULL OR grade_order >= 0)
);
CREATE TRIGGER trg_classes_updated_at BEFORE UPDATE ON classes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  academic_year_id UUID NOT NULL,
  class_id UUID NOT NULL,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(100) NOT NULL,
  capacity INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sections_year_class_code UNIQUE (academic_year_id, class_id, code),
  CONSTRAINT uq_sections_school_id_id UNIQUE (school_id, id),
  CONSTRAINT uq_sections_scope UNIQUE (school_id, academic_year_id, class_id, id),
  CONSTRAINT chk_sections_capacity CHECK (capacity IS NULL OR capacity >= 0),
  CONSTRAINT fk_sections_year_same_school
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sections_class_same_school
    FOREIGN KEY (school_id, class_id) REFERENCES classes(school_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_sections_updated_at BEFORE UPDATE ON sections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX ix_sections_year_class ON sections (school_id, academic_year_id, class_id, status);

CREATE TABLE subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  subject_type VARCHAR(30) NOT NULL DEFAULT 'academic',
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_subjects_school_code UNIQUE (school_id, code),
  CONSTRAINT uq_subjects_school_id_id UNIQUE (school_id, id)
);
CREATE TRIGGER trg_subjects_updated_at BEFORE UPDATE ON subjects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
