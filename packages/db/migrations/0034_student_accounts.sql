ALTER TABLE students ADD COLUMN user_id uuid REFERENCES users(id);
CREATE UNIQUE INDEX uq_students_school_user ON students(school_id,user_id) WHERE user_id IS NOT NULL;
INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code='student' AND p.code IN('learning.submit','notifications.view') ON CONFLICT DO NOTHING;
