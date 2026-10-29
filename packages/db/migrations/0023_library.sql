-- 0023 Library catalogue and circulation.
--
-- A physical copy can only be on one open loan: the partial unique index below
-- makes double issuance impossible even under concurrent requests. Loan and
-- fine parameters live in library_settings so they are explicit school
-- configuration rather than hard-coded policy.

CREATE TABLE library_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  CONSTRAINT uq_library_categories_school_code UNIQUE (school_id, code),
  CONSTRAINT uq_library_categories_school_id_id UNIQUE (school_id, id)
);

CREATE TABLE library_books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  category_id UUID,
  title VARCHAR(300) NOT NULL,
  author VARCHAR(200),
  publisher VARCHAR(200),
  isbn VARCHAR(40),
  language VARCHAR(60),
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_library_books_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_library_books_category
    FOREIGN KEY (school_id, category_id) REFERENCES library_categories(school_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_library_books_isbn
  ON library_books (school_id, isbn) WHERE isbn IS NOT NULL;
CREATE INDEX idx_library_books_title ON library_books (school_id, title);

CREATE TRIGGER trg_library_books_updated_at BEFORE UPDATE ON library_books
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE library_copies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  book_id UUID NOT NULL,
  accession_number VARCHAR(60) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'issued', 'lost', 'damaged', 'retired')),
  acquired_on DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_library_copies_school_accession UNIQUE (school_id, accession_number),
  CONSTRAINT uq_library_copies_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_library_copies_book
    FOREIGN KEY (school_id, book_id) REFERENCES library_books(school_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_library_copies_book ON library_copies (school_id, book_id, status);

CREATE TRIGGER trg_library_copies_updated_at BEFORE UPDATE ON library_copies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE library_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  member_code VARCHAR(60) NOT NULL,
  student_id UUID,
  staff_id UUID,
  borrowing_limit INTEGER NOT NULL CHECK (borrowing_limit BETWEEN 1 AND 50),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'inactive')),
  joined_on DATE NOT NULL DEFAULT current_date,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_library_members_school_code UNIQUE (school_id, member_code),
  CONSTRAINT uq_library_members_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_library_members_student
    FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_library_members_staff
    FOREIGN KEY (school_id, staff_id) REFERENCES staff(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_library_members_subject
    CHECK (((student_id IS NOT NULL)::int + (staff_id IS NOT NULL)::int) = 1)
);

CREATE UNIQUE INDEX uq_library_members_student
  ON library_members (school_id, student_id) WHERE student_id IS NOT NULL;
CREATE UNIQUE INDEX uq_library_members_staff
  ON library_members (school_id, staff_id) WHERE staff_id IS NOT NULL;

CREATE TRIGGER trg_library_members_updated_at BEFORE UPDATE ON library_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE library_settings (
  school_id UUID PRIMARY KEY REFERENCES schools(id) ON DELETE RESTRICT,
  loan_days INTEGER NOT NULL DEFAULT 14 CHECK (loan_days BETWEEN 1 AND 365),
  fine_per_day NUMERIC(10, 2) NOT NULL DEFAULT 5 CHECK (fine_per_day >= 0),
  max_renewals INTEGER NOT NULL DEFAULT 1 CHECK (max_renewals BETWEEN 0 AND 10),
  default_borrowing_limit INTEGER NOT NULL DEFAULT 3
    CHECK (default_borrowing_limit BETWEEN 1 AND 50),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE library_loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  copy_id UUID NOT NULL,
  member_id UUID NOT NULL,
  issued_on DATE NOT NULL DEFAULT current_date,
  due_on DATE NOT NULL,
  returned_on DATE,
  renewed_count INTEGER NOT NULL DEFAULT 0 CHECK (renewed_count >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued', 'returned', 'lost')),
  issued_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  returned_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_library_loans_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_library_loans_copy
    FOREIGN KEY (school_id, copy_id) REFERENCES library_copies(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_library_loans_member
    FOREIGN KEY (school_id, member_id) REFERENCES library_members(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_library_loans_dates CHECK (due_on >= issued_on),
  CONSTRAINT chk_library_loans_returned
    CHECK ((status = 'returned') = (returned_on IS NOT NULL))
);

CREATE UNIQUE INDEX uq_library_loans_open_copy
  ON library_loans (school_id, copy_id) WHERE returned_on IS NULL;

CREATE INDEX idx_library_loans_member ON library_loans (school_id, member_id, issued_on DESC);
CREATE INDEX idx_library_loans_due ON library_loans (school_id, due_on) WHERE returned_on IS NULL;

CREATE TRIGGER trg_library_loans_updated_at BEFORE UPDATE ON library_loans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE library_fines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  loan_id UUID NOT NULL,
  amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  reason VARCHAR(40) NOT NULL
    CHECK (reason IN ('overdue', 'lost', 'damaged')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'waived')),
  assessed_on DATE NOT NULL DEFAULT current_date,
  paid_on DATE,
  recorded_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_library_fines_school_id_id UNIQUE (school_id, id),
  CONSTRAINT uq_library_fines_loan UNIQUE (school_id, loan_id),
  CONSTRAINT fk_library_fines_loan
    FOREIGN KEY (school_id, loan_id) REFERENCES library_loans(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_library_fines_paid CHECK (status <> 'paid' OR paid_on IS NOT NULL)
);

CREATE TABLE library_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  book_id UUID NOT NULL,
  member_id UUID NOT NULL,
  reserved_on DATE NOT NULL DEFAULT current_date,
  expires_on DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'fulfilled', 'cancelled', 'expired')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_library_reservations_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_library_reservations_book
    FOREIGN KEY (school_id, book_id) REFERENCES library_books(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_library_reservations_member
    FOREIGN KEY (school_id, member_id) REFERENCES library_members(school_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_library_reservations_open
  ON library_reservations (school_id, book_id, member_id)
  WHERE status IN ('pending', 'ready');
