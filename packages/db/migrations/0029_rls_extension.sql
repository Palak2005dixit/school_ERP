-- 0029 Extend row-level security and grants to the modules added after 0018.
--
-- Every new school-owned table gets the same tenant_isolation policy used by
-- the original migration. Tables are listed explicitly; a new table must be
-- added here (and covered by a test) before it is considered tenant-safe.
-- This remains defence in depth: the API runs as the database owner locally, so
-- the application-level school_id filters are the primary control.

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
    -- Staff attendance and recruitment
    'staff_shifts', 'staff_shift_assignments', 'staff_attendance',
    'staff_attendance_corrections', 'staff_attendance_settings',
    'vacancies', 'candidates', 'candidate_interviews', 'job_offers',
    'onboarding_tasks', 'employee_changes', 'staff_separations', 'exit_tasks',
    -- Procurement
    'vendors', 'procurement_budgets', 'purchase_requests',
    'purchase_request_items', 'purchase_orders', 'purchase_order_items',
    'goods_receipts', 'goods_receipt_items', 'vendor_bills',
    'procurement_expenses', 'procurement_approvals',
    -- Transport
    'transport_vehicles', 'transport_drivers', 'transport_routes',
    'transport_stops', 'student_transport_allocations', 'transport_maintenance',
    -- Library
    'library_categories', 'library_books', 'library_copies', 'library_members',
    'library_settings', 'library_loans', 'library_fines', 'library_reservations',
    -- Learning
    'learning_resources', 'learning_attachments', 'homework_assignments',
    'homework_submissions', 'question_bank_items',
    -- Concerns
    'concern_categories', 'concerns', 'concern_events', 'concern_attachments',
    -- Notifications
    'notification_templates', 'in_app_notifications', 'notification_preferences',
    'notification_outbox', 'notification_attempts',
    -- Fee reconciliation
    'fee_concession_requests', 'fee_write_offs',
    'fee_reconciliation_batches', 'fee_reconciliation_lines',
    -- Saved reports and imports
    'saved_reports', 'import_batches', 'import_batch_rows'
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
