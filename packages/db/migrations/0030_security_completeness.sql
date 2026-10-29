-- Additive security coverage: every school-owned table must have tenant RLS.
-- Identity lookup remains global; authorization and sessions are never exposed
-- as tenant business data. The API sets the tenant after membership validation.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='school_id'
    WHERE n.nspname='public' AND c.relkind='r'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.relname);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t.relname AND policyname='tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = nullif(current_setting(''app.school_id'',true),'''')::uuid) WITH CHECK (school_id = nullif(current_setting(''app.school_id'',true),'''')::uuid)', t.relname);
    END IF;
  END LOOP;
  -- Foreign-key checks can be deferred during a full logical restore, including
  -- candidate -> staff -> candidate cycles. Ordinary operations remain immediate.
  FOR t IN SELECT conrelid::regclass AS rel, conname FROM pg_constraint
    WHERE contype='f' AND connamespace='public'::regnamespace
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE', t.rel, t.conname);
  END LOOP;
END $$;
