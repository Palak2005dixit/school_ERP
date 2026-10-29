# Test and verification report — 29 October 2026

## Final observed results

| Command | Observed result | Scope / limit |
|---|---|---|
| `npm ci --no-audit --no-fund` | PASS; initial 431 packages installed | Additional test/browser dependencies are captured in the updated lockfile |
| `npm run typecheck` | PASS; 5 workspaces, no type errors | API, web, core, db, shared; final log in `verification/typecheck.log` |
| `npm run lint` | PASS; 0 errors / 0 warnings | Includes static jsx-a11y; does not prove browser accessibility |
| `npm run test:portable` | PASS; **133 tests / 3 files**, 0 failed, 0 skipped; 18.16 seconds | PostgreSQL WASM/PGlite TCP, same Fastify/routes/migrations/RLS; native transaction concurrency is unverified |
| `npm run build` | PASS; web production bundle built in 2.23 seconds | Web build only; no deployment/production API verification |
| Clean migrations + seed | PASS inside both API integration suites | All **34 migrations**; actual source schema/seed, no mock database |
| Migration retry/checksums | PASS in integration suite | All 34 skipped, none reapplied; original migration checksums unchanged |
| Logical backup/recovery | PASS in integration suite | Full connected test DB, private attachment included; corruption rejected before truncation; generated columns handled; row counts roundtrip |
| `npm test` (initial native baseline) | BLOCKED; 2 suite setup failures, all 73 original test cases skipped | Native PostgreSQL refuses root in this UID-0-only execution namespace; final native suite was not claimed successful |
| `npx playwright install chromium` | FAIL; truncated/non-ZIP download; exit 1 | Chromium executable unavailable |
| `npm run test:browser` / `npx playwright test` | BLOCKED; **11 launch failures, 0 page/axe checks executed** | Test API/database/web servers start after environment fixes; every check fails before browser launch because executable is missing |
| CI / production deployment / external providers | NOT EXECUTED | No remote/target/provider credentials supplied |

The last 133-test execution completed in 18.16 seconds. Final subsequent formatting does not change behavior; typecheck/lint were rerun after formatting. Build succeeded with the complete student/workforce additions. Raw final logs are included in `verification/`.

## Suite inventory

- `api.test.ts`: **70** original integration/regression cases. Covers login/session/origin checks, academics, admissions/guardians/enrollment, student attendance and corrections, timetable conflicts, fees/refunds/allocations, results/transcripts, staff salary restrictions/leave/payroll, notices/files/read receipts, safeguarding, reports/exports, accounts/roles, reset/MFA/idempotency and restricted-role RLS.
- `modules.test.ts`: **54** extended integration cases. Covers missing/duplicate punches and corrections; offer-to-employee conversion; purchase approval/budget integrity; transport capacity; library issue/return/renewal; homework/grading/windows/scopes; generic case protection; outbox retry/dedupe/redaction/consent; import preview/re-import; ten cross-school membership denials; RLS coverage/runtime role; live shift assignment/punches; gateway signature/mismatch/deduplication; HR documents; independent separation and revocation; two-approver procurement; seven operational exports; migration retry; concessions/statement matching/write-off denials; dedicated student identity/self-submission/unlink; configured duration thresholds/payroll source access; explicit absence generation; full recovery roundtrip.
- `gateway.test.ts`: **9** deterministic unit cases. Covers fresh/raw HMAC signature validation, stale/changed/malformed rejection, backup preflight and fail-closed scope behavior.

## Diagnosed failures and fixes

1. Supplied `modules.test.ts` had an unused variable and three invalid-request assertions that did not test real workflows. Replaced it with authenticated stateful tests; typecheck/lint now pass.
2. Native embedded PostgreSQL root refusal could not be solved by selecting another identity because only UID 0 is mapped. The portable harness is explicit and test-only; the native backend remains unchanged.
3. Initial portable migration failed because pgcrypto was unavailable. Loaded PGlite's bundled pgcrypto extension; all migration SQL remains intact.
4. Extended tests exposed PostgreSQL parameter inference conflicts in status transitions. Added explicit compatible casts rather than suppressing failures.
5. Attendance upsert silently overwrote saved punches. It is now insert-only, with an explicit correction route and independent reviewer.
6. Offer decisions locked a row outside their update transaction. Lock/update/audit now share the transaction.
7. Duplicate imports could create repeated rows. Preview checks existing committed payloads and same-file duplicates; serialized commit rechecks stale previews and rolls back atomically.
8. Notification retries lacked a stable provider identity and could expose provider exception text. Added stable idempotency keys, provider acknowledgement validation, redacted diagnostics and consent enforcement/recheck.
9. Full logical restore initially failed on generated `line_total`. Restore now inserts only non-generated columns; preflight rejects corrupt/partial payloads before truncation and recovery is transactional.
10. Multi-approver procurement initially violated the original pending-request approval constraint. Pending stage approvals now live in history while final approver fields remain null until final decision.
11. Separation task completion had a UUID inference error. Fixed the transition and verified independent approval, checklist closure and school-role/session revocation.
12. Statement batches could close with unresolved exceptions. Closing now requires all remaining lines matched; the regression test verifies mismatch rejection and eventual closure.
13. Added dedicated student account linking/self-submission, rejected unrelated student submission, hid question-bank answers from learners and enforced learner class filters on resource lists/downloads.
14. Browser startup initially hit the tsx CLI's unavailable Unix socket and an empty archived Windows dependency stub. The fixture uses `node --import tsx`; the generated dependency stub was removed. API/web startup then succeeded. Chromium download failure remains unresolved and is reported as BLOCKED, not application-test success.

## Unverified material risks

Native PostgreSQL simultaneous transactions/upgrade from real school data; complete browser/axe/navigation/file matrices; provider sandbox/live capture/delivery; SSO; production bootstrap grants; large jobs/load; scheduled encrypted backups; production restore and deployment. See `REMAINING_WORK.md` and `REMAINING_BLOCKERS.md` for the remaining implementation and genuine external dependencies respectively.
