# Known Risks and Limitations

Date: 2026-10-29

Risks are ordered by what would block a real pilot. None of the items below are
hidden; they are the reason this build must not be called production-ready.

## Release blockers before a real-school pilot

### R-01 — Row Level Security exists but is not enforced at runtime

RLS policies now exist for tenant-scoped tables (migration `0018_rls.sql`) and an
integration test verifies them under the restricted `erp_app` role with
`app.school_id` set. However, the running API connects as the database **owner**,
which bypasses RLS. In normal operation tenant isolation still depends on the
application guards and SQL scopes. If anyone adds a browser-facing database
client, a BI connector, a second service, or direct owner credentials, isolation
rests on application code. Mitigation: run the API as `erp_app` with per-request
`app.school_id` transaction context and keep the database private.

### R-02 — No production database or scheduled backup

The app runs on an embedded PostgreSQL 18 beta cluster in `.pgdata/` for local
development. There is no managed database, no scheduled backup, no point-in-time
recovery and no tested restore drill. JSON `db:backup`/`db:restore` helpers exist
for local tooling (D-035), but they are not a production backup strategy and
restore truncates data tables. A disk loss destroys all data. Mitigation: choose a
production PostgreSQL provider, document scheduled backups, and run a restore
drill before importing real records.

### R-03 — CI and deployment are unverified

Checks are run manually (`npm run check`), and a GitHub Actions workflow exists,
but it has **never executed** because the workspace has no git remote. There is
no deployment pipeline or staging environment. Mitigation: push the repository,
make the CI job green, then add a staging deploy gate.

### R-04 — Authentication lifecycle still has gaps

Password reset and TOTP MFA now exist, but there is no email delivery: the reset
token is returned only in-app outside production, so a real deployment needs an
email provider. There is no SSO, invitation flow or self-service registration, and
accounts are created by the seed or an administrator. Sessions are revoked on
password reset and account disable, but the account-lockout branch still lacks an
automated test. Treat this as demo-grade authentication, not a finished identity
programme.

## Significant limitations

### R-05 — Idempotency is opt-in and partial

Payments, admissions and payroll-run creation accept an `Idempotency-Key` header
(D-034), which prevents duplicate records on retry when the client sends it.
Guardian linking, enrollment, leave requests, refunds and most other mutations do
**not** support idempotency keys. A client retry after a timeout can still create
duplicate records on those paths. Extend the same mechanism before exposing them
to unreliable networks.

### R-06 — Authorization tests cover API, not every UI path

The integration suite (70 tests) exercises teacher, parent, auditor, finance,
safeguarding, cross-school and cross-origin paths, and the main module flows.
There are still no automated browser tests, so regression in route guards,
dialogs or focus management can pass checks. Student profile edit, the
account-lockout branch, and several modal interactions specifically lack
automated coverage. The newest screens were verified by tests/build but not all
re-clicked in a browser after the final reset.

### R-07 — Timezone handling is partial

Instants display in the school timezone, date defaults use it, and the attendance
future-date check uses the school timezone. Academic-year boundaries are date-only
values. Some server logic still evaluates "today"/year boundaries in database time
(`now()`), and email or scheduled jobs do not exist. If the school timezone differs
from the database timezone around midnight, date-only business rules can be off by
a day.

### R-08 — Audit is append-only but not externally anchored

A database trigger blocks `UPDATE`/`DELETE` on `audit_events` and
`activity_events`, and API writes are transactional with the change they describe.
A database superuser can still disable triggers or drop tables. There is no
external log shipping, hash chaining or WORM storage. Do not present the log as
legally tamper-proof.

### R-09 — Rate limiting is per process and in-memory

`@fastify/rate-limit` uses in-memory state. Running multiple API instances or
restarting the process resets limits. For production, back it with Redis or a
gateway-level limiter.

### R-10 — Cookie security depends on deployment configuration

`COOKIE_SECURE` defaults to `false` for local HTTP. Serving the app without
setting it to `true` behind HTTPS would send the session cookie over plain HTTP.
CSRF defence relies on the `Origin` header plus `SameSite=Lax`, not on a
per-request token.

### R-11 — Demo reset is destructive

`npm run db:reset` drops the entire local `public` schema. It refuses non-local
or production URLs, but a misconfigured `DATABASE_URL` pointing at a dev tunnel
would still be destroyed. Never point it at data you need.

### R-12 — Scope of the product

Implemented: academic structure, admissions/enrollment with CSV import, daily
attendance with corrections, timetables, fees/receipts/refunds/late
fees/instalments/invoices, examinations/report cards/transcripts, staff directory
+ salaries + leave with configurable types/balances + payroll runs, notices with
attachments/read receipts, safeguarding case recording, reports/audited CSV
exports, user/role administration, password reset/MFA, a read-only parent portal,
JSON backup/restore and tested RLS policies. **Not implemented:** statutory
payroll rules, recruitment/appraisals/separation workflows, online payment capture,
notice delivery (email/SMS/WhatsApp), exam promotion/retention, safeguarding
referrals/escalation, SSO/email delivery of invites, runtime RLS enforcement, CI
execution and deployment hardening. Nothing in the UI should imply those exist.

### R-13 — Accessibility only statically linted

Forms use labels, dialogs manage focus and tables have headers. `jsx-a11y` lint
rules now run over the web app and pass, but no browser-based axe run, visual
regression test or manual screen-reader pass has been performed. Keyboard-only
navigation through every dialog is verified only by inspection, not automation.
Keyboard traversal, focus order, contrast and announcements remain unverified.

### R-14 — Performance and scale unmeasured

No load tests exist. Queries are indexed for current access patterns, but the
dashboard runs several aggregate subqueries per request and audit pagination uses
`count(*)`. Measure before a large school or long history is loaded.

### R-15 — Dependency and platform risk

`embedded-postgres` is a beta package and downloads PostgreSQL binaries at install
time; version drift or a blocked download breaks setup. Node 25 is newer than the
LTS line; production should use an active LTS version (22 or 24) even though the
current code passes on 25.4.

### R-16 — Documentation source coverage

Only the master prompt, starter SQL/CSV/MD files and bundle README were read in
detail; the `.docx` blueprint and architecture documents were not parsed
line-by-line. Detailed requirements inside those files may reveal conflicts not
yet recorded in `CLIENT_DECISIONS.md`.

### R-17 — Attendance policy is provisional and deliberately narrow

The register is daily, per section, with a fixed status set (decision D-017).
There is no holiday calendar, period-wise register, cut-off time, minimum
attendance threshold, bulk import or offline mode. A saved row cannot be edited
directly, so even an honest same-day mistake goes through a correction request
(D-018). Teachers only see sections assigned to them. Guardians can now see
attendance history and a computed rate in the portal (D-025), but there is no
whole-school threshold alerting. Approvers are not notified in-app or by email.
Confirm the policy and add holiday/reporting behaviour before a real pilot.

### R-18 — CSV exports are audited, but only with metadata

Report CSV downloads are generated server-side with the same scope rules as the
screens, and each export now writes a `reports.exported` audit event. That record
contains the report name and row count, **not** the exported contents, so it shows
who exported what kind of data and when, but not the exact rows. There is no
watermarking or download-URL expiry. If exports are used with real records, decide
whether row-level export logging or watermarking is required.

### R-19 — Fee, exam, leave, payroll, notice and safeguarding policies are provisional

These modules enforce the rules recorded in `CLIENT_DECISIONS.md`
(D-019–D-036), but those rules were **not supplied by the client**. In particular:
fee refunds are payment-level and do not reverse specific allocations; late fees
post to a single `LATE-FEE` head without waiver/compounding rules; instalment
status is derived from allocations; exam publication locks marks and uses a seeded
8-point scale with no term weighting, promotion logic or cumulative transcript
grade; leave balances assume quota minus approved/pending days with no accrual or
carry-forward; payroll has no statutory deductions; notice delivery and consent are
absent; safeguarding has a single-role access model. Treat displayed totals and
outcomes as correct **relative to these defaults**, not as confirmed school policy.
A policy change may require data migration or recalculation.

### R-20 — Web bundle is code-split but vendor size is unverified

Routes are now loaded with `React.lazy`; the main JS chunk is about `317 kB`
(`100 kB` gzip) and the build no longer emits a chunk-size warning. That is an
improvement, not a performance test: there is no measured first-load budget, no
bundle analysis and no slow-network benchmark. Re-check before a
performance-sensitive deployment.

### R-21 — Sensitive HR data is concentrated in the main administrator

`hr.employee.salary.view_sensitive`, `hr.leave.configure`, `hr.payroll.manage`,
`hr.payroll.approve` and both safeguarding permissions are currently granted only
to `main_admin` (D-009, D-027, D-028). That concentrates pay, payroll approval and
child-protection data in one role with no separation of duties. Confirm the real
HR/finance/safeguarding roles before loading real records.

### R-22 — Payroll is not statutorily compliant

Payroll runs record gross, deductions and net pay and enforce different-user
approval, but no income-tax, provident-fund, insurance, gratuity or jurisdiction
rules are implemented (D-030). Payslips are workflow artifacts, not compliant tax
documents. Do not use them to pay staff until statutory rules and reporting are
specified and implemented.

### R-23 — Safeguarding access is too narrow for real operations

Only `main_admin` can view or manage safeguarding cases (D-028). In a real school
this blocks a designated safeguarding lead, counsellor or head from doing their
job, and it makes one absent account a single point of failure. Case notes are
excluded from audit payloads, but there is no encryption-at-rest story specific to
these records beyond the database default, no legal-hold/retention rule and no
guardian communication workflow. Define the access model and retention policy
before real use.

### R-24 — JSON backup/restore is a local convenience, not disaster recovery

`db:backup` writes a JSON snapshot of data tables and `db:restore` reads it back,
truncating data tables first (D-035). It does not capture schema objects, indexes,
sequences, roles, large-object attachments or binary notice files, and it is
local-only. A restore is destructive and has no dry-run. Use a real PostgreSQL
backup tool and a tested restore procedure for production.

### R-25 — Transcripts and printable documents are single-year snapshots

Transcripts cover published exams in one academic year and show a `null` cumulative
grade by design (D-032). Printable invoices, receipts and transcripts are HTML
rendered with escaped data and auto-print; they are not PDFs, have no institutional
seal/signature, and the transcript layout is not a confirmed school format.
Confirm the official document policy before issuing them to families.

### R-26 — CSV import has a narrow contract

The importer expects specific column names, caps at 500 rows and imports only the
student core fields (D-033). It does not import guardians, previous qualifications,
fee assignments or documents, and each row is admitted independently, so a partial
import is possible. Clarify the real admission spreadsheet format before relying on
it for a term intake.
