-- 0019 Staff attendance and workforce timekeeping.
--
-- Shifts and assignments are configuration; attendance rows are the daily
-- operational record. Late/early/overtime minutes are computed by the API from
-- the assigned shift and the school's provisional grace rule (D-037). A row
-- with only one punch is stored as missing_punch and must go through the
-- correction workflow before payroll can rely on it.

CREATE TABLE staff_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  grace_minutes INTEGER NOT NULL DEFAULT 10
    CHECK (grace_minutes BETWEEN 0 AND 240),
  break_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (break_minutes BETWEEN 0 AND 240),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_staff_shifts_school_code UNIQUE (school_id, code),
  CONSTRAINT uq_staff_shifts_school_id_id UNIQUE (school_id, id),
  CONSTRAINT chk_staff_shifts_times CHECK (ends_at > starts_at)
);

CREATE TRIGGER trg_staff_shifts_updated_at BEFORE UPDATE ON staff_shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE staff_shift_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  staff_id UUID NOT NULL,
  shift_id UUID NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_staff_shift_assignments_school_staff_from
    UNIQUE (school_id, staff_id, effective_from),
  CONSTRAINT uq_staff_shift_assignments_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_staff_shift_assignments_staff
    FOREIGN KEY (school_id, staff_id) REFERENCES staff(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_staff_shift_assignments_shift
    FOREIGN KEY (school_id, shift_id) REFERENCES staff_shifts(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_staff_shift_assignments_dates
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX idx_staff_shift_assignments_lookup
  ON staff_shift_assignments (school_id, staff_id, effective_from DESC);

CREATE TABLE staff_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  staff_id UUID NOT NULL,
  shift_id UUID,
  work_date DATE NOT NULL,
  punch_in TIMESTAMPTZ,
  punch_out TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'present'
    CHECK (status IN ('present', 'late', 'absent', 'half_day', 'leave', 'excused', 'missing_punch')),
  late_minutes INTEGER NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_departure_minutes INTEGER NOT NULL DEFAULT 0 CHECK (early_departure_minutes >= 0),
  overtime_minutes INTEGER NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
  note TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_staff_attendance_school_staff_date UNIQUE (school_id, staff_id, work_date),
  CONSTRAINT uq_staff_attendance_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_staff_attendance_staff
    FOREIGN KEY (school_id, staff_id) REFERENCES staff(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_staff_attendance_shift
    FOREIGN KEY (school_id, shift_id) REFERENCES staff_shifts(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_staff_attendance_punches
    CHECK (punch_out IS NULL OR punch_in IS NULL OR punch_out >= punch_in)
);

CREATE TRIGGER trg_staff_attendance_updated_at BEFORE UPDATE ON staff_attendance
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_staff_attendance_date
  ON staff_attendance (school_id, work_date DESC);
CREATE INDEX idx_staff_attendance_staff
  ON staff_attendance (school_id, staff_id, work_date DESC);

CREATE TABLE staff_attendance_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  attendance_id UUID NOT NULL,
  requested_status VARCHAR(20)
    CHECK (requested_status IN ('present', 'late', 'absent', 'half_day', 'leave', 'excused', 'missing_punch')),
  requested_punch_in TIMESTAMPTZ,
  requested_punch_out TIMESTAMPTZ,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  CONSTRAINT uq_staff_attendance_corrections_school_id_id UNIQUE (school_id, id),
  CONSTRAINT fk_staff_attendance_corrections_attendance
    FOREIGN KEY (school_id, attendance_id) REFERENCES staff_attendance(school_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_staff_attendance_corrections_review
    CHECK (
      (status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
      OR (status IN ('approved', 'rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_staff_attendance_corrections_pending
  ON staff_attendance_corrections (school_id, attendance_id)
  WHERE status = 'pending';

CREATE INDEX idx_staff_attendance_corrections_status
  ON staff_attendance_corrections (school_id, status, requested_at);

CREATE TABLE staff_attendance_settings (
  school_id UUID PRIMARY KEY REFERENCES schools(id) ON DELETE RESTRICT,
  full_day_minutes INTEGER NOT NULL DEFAULT 480 CHECK (full_day_minutes BETWEEN 60 AND 1440),
  half_day_minutes INTEGER NOT NULL DEFAULT 240 CHECK (half_day_minutes BETWEEN 0 AND 1440),
  overtime_after_minutes INTEGER NOT NULL DEFAULT 30 CHECK (overtime_after_minutes >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_staff_attendance_settings_thresholds CHECK (half_day_minutes <= full_day_minutes)
);
