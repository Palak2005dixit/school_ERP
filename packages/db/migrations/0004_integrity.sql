-- 0004 Reference-data integrity and authorization indexes.

-- A user cannot hold the same active grant twice for the same scope.
CREATE UNIQUE INDEX uq_role_assignments_active
  ON user_role_assignments (
    user_id,
    role_id,
    school_id,
    scope_type,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE revoked_at IS NULL;

-- Guardians with a portal account must resolve to exactly one guardian record
-- per school. Identity is global, so a person may be a guardian at two schools.
CREATE UNIQUE INDEX uq_guardians_school_user
  ON guardians (school_id, user_id)
  WHERE user_id IS NOT NULL;

-- Fast, safe lookup of a parent's linked children.
CREATE INDEX ix_student_guardians_verified
  ON student_guardians (school_id, guardian_id)
  WHERE portal_access_status = 'verified' AND valid_to IS NULL;

-- At most one current primary guardian per student.
CREATE UNIQUE INDEX uq_student_guardians_one_primary
  ON student_guardians (student_id)
  WHERE is_primary AND valid_to IS NULL;
