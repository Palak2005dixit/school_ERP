CREATE TABLE hr_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),
 candidate_id uuid,staff_id uuid,filename varchar(255) NOT NULL,content_type varchar(120) NOT NULL,
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 1048576),data bytea NOT NULL,
 document_type varchar(80) NOT NULL,status varchar(20) NOT NULL DEFAULT 'pending' CHECK(status IN('pending','verified','rejected')),
 uploaded_by uuid NOT NULL REFERENCES users(id),reviewed_by uuid REFERENCES users(id),reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((candidate_id IS NOT NULL)::integer+(staff_id IS NOT NULL)::integer=1),
 FOREIGN KEY(school_id,candidate_id) REFERENCES candidates(school_id,id),
 FOREIGN KEY(school_id,staff_id) REFERENCES staff(school_id,id)
);
CREATE INDEX ix_hr_documents_candidate ON hr_documents(school_id,candidate_id);
CREATE INDEX ix_hr_documents_staff ON hr_documents(school_id,staff_id);
ALTER TABLE hr_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON hr_documents USING(school_id=nullif(current_setting('app.school_id',true),'')::uuid) WITH CHECK(school_id=nullif(current_setting('app.school_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON hr_documents TO erp_app;
