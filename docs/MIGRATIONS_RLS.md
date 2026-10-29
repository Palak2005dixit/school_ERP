# Database migrations and RLS verification

## Schema changes

Keep migrations 0001–0029 exactly as supplied. Apply all migrations in lexical order with `npm run db:migrate` using the migration-owner connection.

- **0030_security_completeness.sql** enables tenant policies on every public table containing `school_id`, including older omissions. It makes existing foreign-key checks deferrable, initially immediate, so an explicit recovery transaction can restore cyclic references. Ordinary business transactions do not defer them.
- **0031_payment_boundary.sql** adds payment intents and verified event/reconciliation evidence. Unique provider/event IDs and provider references prevent duplicate capture ingestion; composite FKs prevent cross-school intent/payment links. Both tables have tenant RLS.
- **0032_procurement_policy.sql** adds a bounded independent-approver count per school with tenant RLS.
- **0033_hr_documents.sql** adds private candidate/employee document metadata and bytes. Exactly one subject must be selected; school-composite FKs, file size/type validation, school RLS and server-side HR permissions protect access.

Migrations are forward-only additions/security changes. They do not truncate existing business data. The runner rejects changes to an already-applied checksum. A current migration identity/checksum retry test applies no additional migrations and skips all 34. Clean migrations/seeding execute in every integration test database. A real upgrade from an externally supplied production database was not performed.

- **0034_student_accounts.sql** adds school-unique student/user links and the student submission/inbox role grants. Account linking/revocation is server-authorized and audited.

## Runtime authorization

`tenantContext.ts` creates a request-local store. `requirePermission`/`requireAnyPermission` validate active membership, permission and permission-specific scope before setting the school. `getPool().query` wraps tenant business SQL in a transaction with `SET LOCAL ROLE erp_app` and `set_config('app.school_id',school,true)`. `withTransaction` does the same on the transaction connection. Commit/rollback removes the local role/tenant values before pool reuse.

Global authentication/session/membership operations must resolve identity before a tenant is known. They do not expose a raw SQL API. The payment webhook validates exact signed bytes before a global intent lookup; it then uses that intent's tenant for all event processing. This is the narrowly scoped integration exception; the request cannot supply an arbitrary tenant context.

The bootstrap connection is still privileged enough to switch roles and resolve shared identity. Protect it server-side. A production operator should separate migration ownership from runtime bootstrap credentials, grant only the necessary role membership/global identity operations, and validate this against the chosen host. Merely using this package is not proof of a production least-privilege database deployment.

## Executed evidence

Run `npm run test:portable` for the PGlite/PostgreSQL WASM SQL harness, or `npm test` for native embedded PostgreSQL on a supported non-root host.

The tests cover the original restricted-role RLS check; all school-owned tables having RLS; runtime `erp_app` use on an unfiltered student query; another school's membership denial across ten modules; forbidden parent/teacher operations; guardian-only transport; private document download denial; section-limited homework; safeguarding protection; financial/inventory uniqueness and transactional rollback.

PGlite executes PostgreSQL SQL/RLS/constraints but serializes its pool to one connection. Native concurrent transactions, lock contention, deadlock retries and a production credential/role configuration remain unverified. No RLS policy was disabled to pass tests.

## Restore boundary

Restore is a local, explicitly confirmed CLI operation, not an HTTP endpoint. v2 validates SHA-256 before truncation, requires every current data table exactly once, excludes generated columns from inserts, defers FK checks inside one transaction and rolls back all changes on failure. Legacy v1 backups have structural validation but no cryptographic integrity field. They must match the target schema; restore an older schema to a matching isolated target first, then migrate.

The hash detects corruption; it is not a signature against malicious replacement. JSON includes private files, password hashes, session/reset data and MFA secrets where present in database rows. Encrypt backups, restrict access, transfer securely and rotate restored sessions/secrets before any recovery deployment. Environment secrets, host configuration and non-database files are outside this backup. No production restore or recovery-time objective was verified.
