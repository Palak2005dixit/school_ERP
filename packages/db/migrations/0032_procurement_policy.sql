CREATE TABLE procurement_settings (
 school_id uuid PRIMARY KEY REFERENCES schools(id),
 required_approvals integer NOT NULL DEFAULT 1 CHECK(required_approvals BETWEEN 1 AND 5)
);
ALTER TABLE procurement_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON procurement_settings USING(school_id=nullif(current_setting('app.school_id',true),'')::uuid) WITH CHECK(school_id=nullif(current_setting('app.school_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON procurement_settings TO erp_app;
