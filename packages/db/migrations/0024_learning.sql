-- 0024 Learning resources, homework, submissions and question bank.
--
-- Resource and submission files are stored as BYTEA with the same size cap the
-- API enforces for notice attachments. A submission belongs to an enrolled
-- student and is never public: reads require the learning permission or a
-- guardian link to that student.

CREATE TABLE learning_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  resource_type VARCHAR(30) NOT NULL DEFAULT 'document'
    CHECK (resource_type IN ('document', 'link', 'video', 'audio', 'image', 'other')),
  subject_id UUID,
  class_id UUID,
  url VARCHAR(1000),
  visibility VARCHAR(20) NOT NULL DEFAULT 'all'
    CHECK (visibility IN ('all', 'staff', 'students', 'parents')),
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_learning_resources_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_learning_resources_subject
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_resources_class
    FOREIGN KEY (school_id, class_id) REFERENCES classes(school_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER trg_learning_resources_updated_at BEFORE UPDATE ON learning_resources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE learning_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  resource_id UUID NOT NULL,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(120) NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 1048576),
  data BYTEA NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_learning_attachments_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_learning_attachments_resource
    FOREIGN KEY (school_id, resource_id) REFERENCES learning_resources(school_id, id) ON DELETE CASCADE
);

CREATE TABLE homework_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  academic_year_id UUID NOT NULL,
  section_id UUID NOT NULL,
  subject_id UUID NOT NULL,
  title VARCHAR(200) NOT NULL,
  instructions TEXT NOT NULL,
  available_from DATE,
  due_at TIMESTAMPTZ NOT NULL,
  max_marks NUMERIC(6, 2) CHECK (max_marks IS NULL OR max_marks > 0),
  allow_resubmission BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'closed')),
  published_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_homework_assignments_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_homework_assignments_year
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_homework_assignments_section
    FOREIGN KEY (school_id, section_id) REFERENCES sections(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_homework_assignments_subject
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_homework_assignments_published
    CHECK ((status <> 'published') OR published_at IS NOT NULL)
);

CREATE TRIGGER trg_homework_assignments_updated_at BEFORE UPDATE ON homework_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_homework_assignments_section
  ON homework_assignments (school_id, section_id, due_at DESC);

CREATE TABLE homework_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  assignment_id UUID NOT NULL,
  student_id UUID NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 10),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status VARCHAR(20) NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'late', 'reviewed', 'returned')),
  content TEXT,
  attachment_name VARCHAR(255),
  attachment_type VARCHAR(120),
  attachment_size INTEGER CHECK (attachment_size IS NULL OR attachment_size BETWEEN 1 AND 1048576),
  attachment_data BYTEA,
  marks NUMERIC(6, 2) CHECK (marks IS NULL OR marks >= 0),
  feedback TEXT,
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  CONSTRAINT uq_homework_submissions_attempt UNIQUE (school_id, assignment_id, student_id, attempt),
  CONSTRAINT uq_homework_submissions_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_homework_submissions_assignment
    FOREIGN KEY (school_id, assignment_id) REFERENCES homework_assignments(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_homework_submissions_student
    FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_homework_submissions_review
    CHECK ((status IN ('reviewed', 'returned')) = (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CONSTRAINT chk_homework_submissions_attachment
    CHECK (
      (attachment_data IS NULL AND attachment_name IS NULL AND attachment_type IS NULL AND attachment_size IS NULL)
      OR (attachment_data IS NOT NULL AND attachment_name IS NOT NULL AND attachment_type IS NOT NULL AND attachment_size IS NOT NULL)
    )
);

CREATE INDEX idx_homework_submissions_student
  ON homework_submissions (school_id, student_id, submitted_at DESC);

CREATE TABLE question_bank_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  subject_id UUID NOT NULL,
  topic VARCHAR(160),
  question_type VARCHAR(20) NOT NULL DEFAULT 'short_answer'
    CHECK (question_type IN ('short_answer', 'long_answer', 'multiple_choice', 'true_false', 'practical')),
  difficulty VARCHAR(20) NOT NULL DEFAULT 'medium'
    CHECK (difficulty IN ('easy', 'medium', 'hard')),
  question_text TEXT NOT NULL,
  answer_text TEXT,
  marks NUMERIC(6, 2) CHECK (marks IS NULL OR marks > 0),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_question_bank_items_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_question_bank_items_subject
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects(school_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_question_bank_items_subject
  ON question_bank_items (school_id, subject_id, difficulty);
