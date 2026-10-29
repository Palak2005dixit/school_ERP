# Implementation progress — 29 October 2026

## Starting point
Supplied archive has operational modules A–J already in source and migrations 0019–0029, despite the older status document reporting an 18-migration baseline. No .git directory or uncommitted-change inventory was supplied. Original source was extracted without replacing the supplied archives.

## Executed so far
- `npm ci --no-audit --no-fund` succeeded.
- Initial typecheck/lint failed on the supplied unused test variable.
- Native PostgreSQL test startup blocked: this execution namespace maps UID 0 only; PostgreSQL refuses root and cannot create another mapped UID.
- Added opt-in **test-only** PGlite TCP harness; original 70 regression tests passed using actual PostgreSQL WASM SQL, unchanged migrations/seed and Fastify routes.
- Replaced three non-functional negative-only tests with 26 workflow/authorization tests; all 26 passed before subsequent additions.
- Added request-context tenant RLS to ordinary queries and transactions. Original 70 regressions passed again with this enabled.
- Added migration 0030 for previously omitted school-owned RLS tables and defer-capable foreign keys for recovery.
- Fixed overwrite-prone staff attendance, non-transactional offer decisions, SQL parameter type conflicts, submission availability, notification retry identity/redaction, and duplicate CSV re-import.
- Added staff shift assignment and live punches with UI; backup v2 integrity/preflight; signed payment bridge contract, idempotent event ingestion, exception queue and receipt reconciliation with UI.

## Next verification and unfinished work
Run typecheck/lint and both integration suites after latest additions. Add payment ingestion, backup rollback/roundtrip and live-punch tests. Inspect teacher learning section scopes and private attachment access. Run production build and browser checks. Reconcile final module/subrequirement statuses and persist updated source archive.

Do not interpret this checkpoint as a declaration that the complete requested scope is finished. Native PostgreSQL concurrency, real providers, SSO and deployment remain unverified. Remaining code gaps must be listed separately from external blockers.

## Later implementation (same continuous run)
- Expanded integration coverage to fee concession/reconciliation, explicit consent, school circulation access, operational exports, private HR documents, independent separation, multi-approver procurement and migration retry.
- Added migration 0034: dedicated student login links. Added student self-submission, learner listing, unlink revocation, class-filtered resources/private downloads and staff-only question-bank answer access. Added account-linking UI in student detail.
- Added explicit working-day absence generation (insert-only, past periods, holidays/approved leave excluded), enabled-duration classification from configured thresholds, and a read-only attendance/leave source preview for payroll. No statutory salary formula or automatic deduction was introduced.
- Latest intermediate suite reached 132 passing tests before absence-generator coverage; rerun full verification after the final edits. Earlier 33-migration counts in the checkpoint are superseded by 34.

## Final handover checkpoint

- Current schema: **34** migrations; all original 0001–0029 checksums retained.
- Latest full portable suite: **133/133 PASS**, comprising original 70 + extended 54 + deterministic 9. Zero skipped in that run. Native concurrency remains unverified.
- Typecheck, static accessibility lint and web build have passed; final command logs are preserved in `verification/`.
- Eleven automated browser/axe checks are present but blocked before launch by unavailable Chromium. External messaging/payment/SSO and deployment are not represented as verified.
- Student accounts and workforce duration/absence/payroll-source additions are now implemented and tested; the older checkpoint tasks for those are superseded.
- The updated root status, traceability, setup/user/integration/database docs and separate remaining code/dependency lists are authoritative. Original source documentation remains under `docs/baseline/`.
- **Next unfinished task:** assessment/question-bank linking, then full procurement amendment/versioning and role/threshold approval policy. Continue through the specific remaining items in `REMAINING_WORK.md`. Overall mission remains PARTIAL; do not claim every requested module is complete.
