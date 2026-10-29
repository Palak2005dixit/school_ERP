-- 0018 Row-level security policies (defence in depth).
--
-- The API enforces tenant isolation in every query. These policies add a second
-- layer when the application connects as the restricted `erp_app` role and sets
-- `app.school_id` for the transaction. The default local owner connection is
-- not subject to RLS, so this migration does not change local behaviour; it is
-- a deployment hardening step documented in README.md.

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    CREATE ROLE erp_app NOLOGIN;
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping erp_app role creation (insufficient privilege)';
END
$role$;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT USAGE ON SCHEMA public TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app;
  END IF;
END
$grants$;

DO $policies$
DECLARE
  tenant_table TEXT;
  policy_expression TEXT :=
    'school_id = nullif(current_setting(''app.school_id'', true), '''')::uuid';
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'academic_years', 'classes', 'sections', 'subjects',
    'students', 'guardians', 'student_guardians', 'enrollments',
    'attendance_records', 'timetable_slots',
    'fee_heads', 'fee_structures', 'student_charges', 'payments',
    'payment_allocations', 'refunds', 'fee_late_fee_rules',
    'late_fee_assessments', 'fee_installment_plans',
    'exams', 'exam_subjects', 'exam_marks',
    'staff', 'staff_salaries', 'leave_requests', 'leave_types', 'holidays',
    'payroll_runs', 'payslips',
    'notices', 'notice_attachments', 'notice_receipts',
    'safeguarding_cases', 'safeguarding_notes',
    'audit_events', 'idempotency_keys'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tenant_table
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tenant_table);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)',
        tenant_table, policy_expression, policy_expression
      );
    END IF;
  END LOOP;
END
$policies$;
