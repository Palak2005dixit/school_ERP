-- 0005 Attendance corrections.
--
-- Daily attendance rows live in student_attendance (migration 0003). Once a
-- register row exists it is only changed through a correction request that a
-- different user reviews. The original status therefore stays intact until an
-- approval commits, which keeps the evidence trail honest.

-- Composite key so attendance corrections cannot link across schools.
ALTER TABLE student_attendance
  ADD CONSTRAINT uq_student_attendance_school_id_id UNIQUE (school_id, id);

CREATE TABLE attendance_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  attendance_id UUID NOT NULL,
  requested_status VARCHAR(20) NOT NULL
    CHECK (requested_status IN ('present', 'absent', 'late', 'half_day', 'excused')),
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  CONSTRAINT fk_attendance_corrections_attendance
    FOREIGN KEY (school_id, attendance_id)
    REFERENCES student_attendance(school_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_attendance_correction_reason
    CHECK (length(btrim(reason)) >= 5),
  CONSTRAINT chk_attendance_correction_review
    CHECK (
      (status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
      OR (status IN ('approved', 'rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    )
);

-- At most one pending correction per attendance row. Reviewed corrections are
-- kept forever, so the history is append-only at the workflow level.
CREATE UNIQUE INDEX uq_attendance_corrections_pending
  ON attendance_corrections (attendance_id) WHERE status = 'pending';
CREATE INDEX ix_attendance_corrections_school_status
  ON attendance_corrections (school_id, status, requested_at);
CREATE INDEX ix_attendance_corrections_requester
  ON attendance_corrections (requested_by, requested_at DESC);
