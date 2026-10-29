-- 0028 Saved report views and two-step CSV imports.
--
-- A saved report stores only the query definition (type + filters) plus a name;
-- results are recomputed on open so a saved view can never show stale totals.
-- An import is always previewed first: rows and validation errors are stored,
-- then a separate commit call applies only the valid rows. Committing twice is
-- refused, which makes the workflow safe to retry after a dropped connection.

CREATE TABLE saved_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  name VARCHAR(120) NOT NULL,
  report_type VARCHAR(40) NOT NULL
    CHECK (report_type IN ('students', 'attendance', 'fees')),
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  shared BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_saved_reports_school_name UNIQUE (school_id, name),
  CONSTRAINT uq_saved_reports_school_id_id UNIQUE (school_id, id)
);

CREATE TRIGGER trg_saved_reports_updated_at BEFORE UPDATE ON saved_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_saved_reports_owner
  ON saved_reports (school_id, created_by, name);

CREATE TABLE import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  entity_type VARCHAR(40) NOT NULL
    CHECK (entity_type IN ('students', 'library_books', 'vendors')),
  filename VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'previewed'
    CHECK (status IN ('previewed', 'committed', 'cancelled')),
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  valid_rows INTEGER NOT NULL DEFAULT 0 CHECK (valid_rows >= 0),
  invalid_rows INTEGER NOT NULL DEFAULT 0 CHECK (invalid_rows >= 0),
  created_rows INTEGER NOT NULL DEFAULT 0 CHECK (created_rows >= 0),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  committed_at TIMESTAMPTZ,
  CONSTRAINT uq_import_batches_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_import_batches_counts CHECK (valid_rows + invalid_rows = total_rows),
  CONSTRAINT chk_import_batches_commit CHECK (
    (status = 'committed') = (committed_at IS NOT NULL)
  )
);

CREATE INDEX idx_import_batches_owner
  ON import_batches (school_id, created_by, created_at DESC);

CREATE TABLE import_batch_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL,
  row_number INTEGER NOT NULL CHECK (row_number > 0),
  payload JSONB NOT NULL,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  action VARCHAR(20) NOT NULL DEFAULT 'skip'
    CHECK (action IN ('create', 'update', 'skip')),
  created_entity_id UUID,
  CONSTRAINT uq_import_batch_rows_batch_row UNIQUE (school_id, batch_id, row_number),
  CONSTRAINT uq_import_batch_rows_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_import_batch_rows_batch
    FOREIGN KEY (school_id, batch_id) REFERENCES import_batches(school_id, id)
    ON DELETE CASCADE
);

CREATE INDEX idx_import_batch_rows_batch
  ON import_batch_rows (school_id, batch_id, row_number);
