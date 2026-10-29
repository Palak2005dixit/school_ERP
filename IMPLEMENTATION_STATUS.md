# Implementation Status

Date: 2026-10-29
Repository: `school-erp/` (new project scaffold created from the planning bundle)

This document records what is **actually implemented and executed**, what is
deferred, and the evidence for each claim. It is not a promise of completeness.

## 1. Baseline inspected

Source documents read before building:

- `09_Master_Prompt/SCHOOL_ERP_MASTER_IMPLEMENTATION_PROMPT.md` (authoritative
  build directive)
- `05_Workflows/School_ERP_Workflow_Tracking_Register.csv`
- `04_Roles_and_Permissions/School_ERP_Permission_Catalogue_Starter.csv`
- `03_Database_Design/School_ERP_PostgreSQL_Schema_Starter.sql`,
  `School_ERP_Logical_ER_Diagram.md`
- `School_ERP_All_Deliverables_Implementation_Starter/README.md`

The bundle is a **planning package only** — it contained no application source
code. This repository was scaffolded from scratch. The `.docx`/`.xlsx` artifacts
were not parsed line-by-line; requirements were taken from the provided CSV/MD/SQL
starters and the master prompt. Treat the detailed blueprint prose as still to be
reconciled (see `CLIENT_DECISIONS.md`).

## 2. Environment

| Item | Verified value |
| --- | --- |
| OS | Windows (`win32`) |
| Node.js | v25.4.0 (engines require >= 22) |
| npm | 11.7.0 |
| Database | Embedded PostgreSQL 18 (`embedded-postgres` 18.4 beta), no Docker |
| Ports | DB 5433, API 4000, web 5173 |

## 3. Implemented scope

### 3.1 Identity, access and audit (slice 1)

- `users`, `roles`, `permissions`, `role_permissions`, `user_role_assignments`,
  `sessions`, `audit_events`, `activity_events` tables (migration 0001).
- Email/password login with scrypt, timing-safe verification, per-account lockout
  after 10 failures, per-IP login rate limit, server-side sessions stored as
  SHA-256 token hashes, httpOnly `erp_session` cookie, logout, `/api/auth/me`,
  change-password that revokes other sessions.
- Permission catalogue and six baseline roles
  (`main_admin`, `academic_coordinator`, `teacher`, `finance`, `parent`,
  `auditor`), granted with school/section/linked-student scope.
- Server-side guards on every protected route; denied attempts audited with the
  missing permission code.
- Append-only `audit_events` and `activity_events` enforced by trigger.
- Origin check for cookie-authenticated mutations; helmet headers; rate limiting.
- Audit page (admin/auditor) with pagination and sanitized before/after summary.

### 3.2 Academic structure (slice 1)

Migration 0002 adds academic years, terms, classes, sections, subjects,
`school_counters`, teaching assignments.

- Create/edit academic years and **activate exactly one** (transactional; previous
  active year is closed).
- Create/edit classes, sections (year + class + capacity, duplicate guard,
  year/class consistency checks) and subjects.
- Read endpoints are scoped: teachers only see their assigned sections.

### 3.3 Admissions, students, guardians, enrollment (slice 2)

Migration 0003 adds students, guardians, student_guardians, enrollments, and the
`student_attendance` table used by the attendance slice.

- Admissions create student + enrollment + guardians in one transaction, with an
  atomic per-school admission number (`ADM-2026-00001` style).
- Automatic primary-guardian rule: at most one current primary guardian per
  student (partial unique index + validation).
- Guardian linking with relationship, primary flag and portal verification status.
- Enrollment into a section of the active year with membership/duplicate checks.
- Student list with search (name/admission number), class/section/status filters
  and pagination; student detail with edit, guardians and enrollments.
- Parent portal endpoint returns only children with a **verified** guardian link
  for the signed-in user.
- Every admission/edit/link/enrollment writes audit + activity events.

### 3.4 Attendance and corrections (slice 3)

Migration 0005 adds `attendance_corrections` with a composite school-scoped FK to
`student_attendance`, a review-state check, one pending correction per attendance
row, and lookup indexes.

- Daily register endpoint for one section/date, restricted to sections the actor
  can see; teachers are limited to their assigned sections.
- Register rows are **insert-only** (`ON CONFLICT DO NOTHING`), so re-submitting a
  saved register cannot silently overwrite a recorded status.
- Statuses: `present`, `absent`, `late`, `half_day`, `excused`. No attendance
  thresholds, holiday calendar or period-wise model is assumed.
- Date validation: the date must fall inside the section's academic year and may
  not be later than today in the **school's** timezone.
- Only students with an active enrollment covering the register date can be marked.
- After a row is saved, a teacher must raise a correction request with a reason;
  an approver with `attendance.correction.approve` (admin or coordinator) accepts
  or rejects it.
- Approval changes the saved status transactionally and records `source =
  'correction'`; rejection leaves the original status untouched. A request cannot
  be approved by the user who raised it.
- Register saves, requests, approvals, rejections and self-approval denials write
  audit events (and activity events for the student timeline).
- UI at `/attendance`: year/section/date selectors, draft entry for unmarked
  students, "mark remaining present", saved-row locking, correction dialog and an
  approver queue with approve/reject dialogs. Read-only for auditors and users
  without record permission.

### 3.5 Timetable (migration 0006)

Migration 0006 adds `timetable_periods`, `rooms` and `timetable_slots`.

- Periods are defined per academic year (name, sequence, start/end clock, break
  flag); rooms carry a code, name, capacity and status.
- A slot binds section + period + day-of-week to a subject, a teacher and a room.
  Inputs are validated against the same school, academic year and section.
- Database unique indexes reject double-booked **sections**, **teachers** and
  **rooms** for the same period/day; the API returns a conflict instead of a 500.
- UI at `/academic/timetable`: year/section pickers, a weekly grid with add/remove
  slots, plus period and room management tabs. All controls are hidden or disabled
  without `academic.timetable.manage`.
- Permissions: `academic.structure.view` to read, `academic.timetable.manage` to
  change periods, rooms or slots.

### 3.6 Fees (migration 0007)

Migration 0007 adds `fee_heads`, `fee_structures`, `student_charges`, `payments`,
`payment_allocations` and `refunds`.

- All money is PostgreSQL `NUMERIC(12,2)`; amounts are parsed and rounded in one
  place. Every balance is derived from charges, concessions, allocations and
  approved refunds — no balance column is stored.
- Fee heads and per-class/year structures define the price list. Bulk generation
  creates one charge per student/year/fee head (unique constraint), so retries do
  not duplicate charges.
- Charges support per-student concessions with a reason. A payment records the
  receipt number, method and date, and **must allocate** its full amount across
  the student's open charges; allocations may not exceed a charge or cross
  students.
- Refunds are raised against a receipt, capped by the payment amount, and must be
  reviewed by a **different** user holding `fees.refund.approve` (self-approval is
  rejected). Approved refunds reduce net collected and raise outstanding.
- Overview totals, per-charge status (`paid` / `partial` / `unpaid`), payment
  history, refund queue, fee structures and a per-student ledger are served from
  the ledger, not cached figures.
- Permissions: `fees.view`, `fees.charge.create`, `fees.payment.verify`,
  `fees.refund.approve`.

### 3.7 Examinations (migration 0008)

Migration 0008 adds `grading_schemes`, `grading_bands`, `exams`, `exam_subjects`
and `exam_marks`.

- Grading schemes hold ordered percentage bands with a grade code and pass flag;
  the seeded scheme is a provisional 8-point scale.
- Exams carry a type, date range, scheme and status (`draft` / `published`).
  Subjects can be added with a maximum mark.
- Marks are entered per exam subject and student, validated against the section's
  active enrollment and the subject maximum.
- Publishing requires at least one recorded mark for **every** exam subject.
  Publication locks mark entry and stamps the publisher/time; unpublishing reopens
  entry. Report cards show per-subject marks, grades, totals, percentage and an
  overall grade, or an explicit `incomplete` state.
- Permissions are split: `exams.manage` (schemes, exams, subjects),
  `exams.marks.record` (marks), `exams.results.publish` (publish/unpublish), with
  `exams.view` for reads.

### 3.8 Staff and HR (migration 0009)

Migration 0009 adds `staff`, `staff_salaries` and `leave_requests`.

- Staff records hold employee number, name, contact, designation, department, join
  date and status, and can be linked to a login account. Employee numbers are
  generated when omitted and are unique per school.
- Salary lives in a separate `staff_salaries` table and is readable only with
  `hr.employee.salary.view_sensitive`. Salary audit entries record the effective
  date and currency but **never the amount**.
- Leave is separate from staff status. Requests carry type, date range, computed
  days and reason. Non-approvers can only request for their own staff record;
  overlapping pending/approved requests are rejected; nobody may approve their own
  request; cancellation is allowed only while pending.
- UI at `/staff` gates every tab by permission: staff directory
  (`hr.employee.view`), salaries (salary permission), leave (request or approve).
  A leave-only user lands directly on the Leave tab, and the staff query is not
  issued for them.

### 3.9 Notices (migrations 0010, 0011)

Migration 0010 adds `notices`; 0011 adds `notice_attachments` and
`notice_read_receipts`.

- Notices have a title, body, audience (`all` / `staff` / `parents` / `students`),
  status (`draft` / `published` / `archived`), optional pin and expiry date.
- Managers (`notices.manage`) see drafts and archived notices and can publish,
  unpublish, archive and delete (published notices must be archived first).
- Every other reader sees only published, unexpired notices addressed to the
  audiences derived from their **server-side roles**, not from client input.
  Guardians see `parents` and `all` notices in the portal.
- Attachments are uploaded through the API with a 2 MiB request limit and a 1 MiB
  decoded-size cap; download re-checks the notice's audience visibility.
- Each reader has a per-user read receipt; the notice board shows unread counts.

### 3.10 Reports and exports

- `/reports` shows an attendance summary, fees by head, fees by class, collections
  by method and a student roster, all computed from row data at request time and
  narrowed to the actor's visible sections.
- Attendance rate is
  `(present + late + 0.5 × half_day) ÷ marked`, with `excused` counted as marked
  but not attended (provisional; see D-025).
- CSV export is generated **on the server** with a UTF-8 BOM, using the same
  queries as the screen and the same scope rules. Each export appends a
  metadata-only `reports.exported` audit event (report name and row count, never
  the file contents).

### 3.11 Parent portal expansion

- The portal lists only verified linked children.
- Per child: attendance history and rate, fee ledger with receipts and balances,
  published report cards, and published notices addressed to guardians.
- Everything is read-only; no guardian edit or payment action exists.

### 3.12 Users and roles

- `/users` lists accounts with status, roles and scopes; administrators can create
  an account with a password and one or more role assignments, grant or revoke
  roles, and disable/lock an account (which revokes its sessions immediately).
- Guards reject self-disable/self-lock and revoking the administrator's own last
  role; role scopes must match the role's allowed scope type.
- Permission: `access.roles.manage`.

### 3.13 Web application

- Login (with demo-account picker, forgot/reset password, MFA code challenge),
  session bootstrap, route guards, profile, change-password and MFA setup.
- App shell with role-aware navigation and responsive layout; routes are
  code-split with `React.lazy` + `Suspense`.
- Dashboard: live counts, students by class, active year, pending guardian links,
  recent activity (no hard-coded numbers).
- Academic pages: years, classes, sections, subjects — create/edit dialogs,
  activation, validation errors, empty/loading/error states.
- Students: searchable/filterable/paginated list, admission form, CSV import
  dialog, detail page with profile edit, guardian link and enrollment dialogs.
- Attendance register page with the correction approval queue (see 3.4).
- Timetable page with weekly grid, periods and rooms (3.5).
- Fees page with charges, payments, refunds, fee structures and a late
  fees/instalments tab, plus invoice and receipt links (3.6, 3.17).
- Exams page with schemes, subjects, marks, report cards and transcript links
  (3.7, 3.18).
- Staff & HR page with permission-gated directory, salaries, leave, leave setup
  and payroll tabs (3.8, 3.15, 3.16).
- Notice board with audience/status filters, attachments and read receipts (3.9).
- Safeguarding page at `/safeguarding` behind `safeguarding.case.view` (3.14).
- Reports page with live tables and CSV downloads (3.10).
- Users & roles page (3.12), expanded parent portal (3.11), audit log, 404, toasts
  and accessible dialogs.

### 3.14 Safeguarding (migration 0012)

Migration 0012 adds `safeguarding_cases` and `safeguarding_case_notes`.

- Cases carry a category, severity, status, summary, opened/closed dates and the
  reporting staff member. Notes are separate append-only rows.
- Permissions `safeguarding.case.view` and `safeguarding.case.manage` are granted
  only to `main_admin` provisionally (D-028); the concentration of access is
  recorded as a risk.
- Opening, changing status/severity, adding notes and closing a case write audit
  events. Case summaries, note text and student names are **not** copied into the
  audit payload.
- UI at `/safeguarding` is hidden without `safeguarding.case.view`; the API
  enforces the same permission.

### 3.15 Leave configuration and balances (migration 0013)

Migration 0013 adds `leave_types` and `holidays`.

- Leave types hold a code, name, annual quota, paid flag and active flag. Seed
  codes are `casual`, `earned`, `sick`, `maternity`, `unpaid`.
- Holidays are per school and calendar year; they are displayed with leave
  information but do not automatically shorten a request.
- Balances are derived (quota minus approved/pending days for the selected
  calendar year) with no carry-forward (D-029). The derivation starts at the
  selected year and does not backfill prior service.
- Configuration requires `hr.leave.configure`; requesters see their own balance.
- UI: Staff page → Leave setup tab; the leave request dialog uses the configured
  types with a fallback list when none are active.

### 3.16 Payroll (migration 0014)

Migration 0014 adds `payroll_runs`, `payslips` and `payslip_items`.

- A run covers one month/year and one school; each payslip links a staff record
  and carries gross, deductions and net pay. All amounts are `NUMERIC(12,2)`.
- A run moves `draft` → `approved` → `paid`. Approval must come from a different
  user than the creator (`hr.payroll.approve`); a run cannot be edited after
  approval.
- Amounts are excluded from audit state; only status changes and run metadata are
  recorded.
- No statutory deduction rules (tax, provident fund, insurance) are built in;
  deductions are entered explicitly and remain client-confirmed defaults (D-030).
- UI: Staff page → Payroll tab (gated by `hr.employee.salary.view_sensitive`),
  list runs, create a draft, approve and mark paid, and view payslips.

### 3.17 Fee extras: late fees, instalments and printable documents (migration 0015)

Migration 0015 adds `late_fee_rules`, `late_fee_assessments` and
`instalment_plans`.

- A late-fee rule defines a grace period, amount and recurrence per academic year.
  Running it creates one assessment per charge per day (unique constraint) and
  posts the amount to the dedicated `LATE-FEE` fee head, incrementing that yearly
  charge.
- Instalment plans hold a charge reference, due dates and amounts; instalment
  status is derived from charge-level allocations (D-031).
- Invoices and receipts are server-rendered printable HTML with escaped output and
  auto-print, gated by staff fee permission or the guardian link. Transcripts use
  the same approach.
- UI: Fees page → "Late fees & instalments" tab, plus links from the ledger and
  the parent portal.

### 3.18 Transcripts

- `GET /students/:id/transcript` (staff) and
  `/portal/children/:id/transcript` (guardian) return every published exam in the
  academic year with per-subject marks and an overall total.
- The cumulative grade is intentionally `null` because grading bands may change
  between exams (D-032).
- A printable HTML transcript is available from the exams report-card dialog and
  the parent portal.

### 3.19 Student CSV import

- `POST /students/import` accepts up to 500 rows of RFC 4180 CSV. Required
  columns: `first_name`, `class_name`, `section_name`. Optional:
  `admission_number`, `middle_name`, `last_name`, `date_of_birth`.
- Each row is admitted inside its own transaction, so one bad row does not abort
  the rest; per-row errors are returned with row numbers and an import-summary
  audit event is written (D-033).
- UI: Students page → "Import CSV" dialog with academic-year picker, file or paste
  input, and a result/error list.

### 3.20 Authentication hardening, idempotency and RLS (migrations 0016–0018)

- 0016 adds `password_reset_tokens` and TOTP columns on `users`. Forgot-password
  issues a single-use expiring token; reset replaces the password and revokes all
  sessions. TOTP enrolment produces a secret and `otpauth://` URL; login requires
  a valid code once enabled. The dev token is returned only outside production.
- 0017 adds `idempotency_keys`. Payment, admission and payroll-run creation accept
  an `Idempotency-Key` header keyed by school/user/route; an identical replay
  returns the stored response and a mismatched payload is rejected (D-034).
- 0018 adds RLS policies for tenant-scoped tables plus an optional `erp_app` role.
  Tests switch to `erp_app` with `app.school_id` set to verify isolation. The
  running API still uses the owner connection, which bypasses RLS (R-01).

### 3.21 Tooling and operations

- npm workspaces; strict TypeScript with a shared base config per package.
- Migrations runner with checksum tracking (`schema_migrations`); **18 migrations**
  (`0001`–`0018`).
- Idempotent synthetic seed (school, 5 classes, 10 sections, 6 subjects, 6
  students, guardians/enrollments, users, seeded admission audit/activity history,
  timetable periods/rooms/20 slots, fee heads/structures/charges/payments, a
  late-fee rule, an instalment plan, a grading scheme, a draft exam with marks,
  five staff records with salaries and leave requests, leave types/holidays, an
  approved September 2026 payroll run with payslips, a synthetic safeguarding case,
  and four notices).
- Embedded PostgreSQL dev server and disposable test database on a **random free
  port** (avoids collisions with interrupted runs).
- JSON `db:backup` / `db:restore` CLI helpers (`to_jsonb` export,
  `jsonb_populate_record` import); restore is local-only, requires `--yes` and
  truncates data tables first (D-035).
- ESLint 9 flat config including `eslint-plugin-jsx-a11y` static accessibility
  rules for the web app; Prettier formatting script; Vitest 4 integration suite.
- GitHub Actions workflow (`.github/workflows/ci.yml`) running typecheck, lint,
  tests and build on Node 22. **Not yet executed** — the workspace has no git
  remote, so the pipeline definition is unverified.
- `.env.example` and `.gitignore` (`.env`, `.pgdata/`, `dist/` ignored).

## 4. Verification evidence (executed 2026-10-29)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck (5 workspaces) | `npm run typecheck` | **Pass** — api, web, core, db, shared |
| Lint (incl. jsx-a11y) | `npm run lint` | **Pass** — 0 errors, 0 warnings |
| Integration tests | `npm test` | **Pass — 70/70 tests**, ~48 s |
| Web production build | `npm run build` | **Pass** — main JS `317.50 kB` / `99.94 kB` gzip, CSS `37.36 kB` / `7.27 kB` gzip, 124 modules, no chunk warning |
| Dependency audit | `npm audit` | **0 vulnerabilities** (full tree) |
| Clean DB migration + seed | `npm run db:reset` | **Pass** — **18 migrations** applied, 6 students, 6 users, demo school created |
| Browser smoke test | in-app Chromium | Admin, coordinator, teacher, finance, auditor and parent flows checked after an earlier reseed |

Browser smoke test details (fresh seed at the time of those checks):

- Admin `/academic/timetable` → Grade 1 · Section A, 20 weekly slots across periods
  1–4, with remove controls and periods/rooms tabs.
- Admin `/fees` → charged ₹3,32,000.00, collected ₹1,68,000.00, outstanding
  ₹1,64,000.00 across 13 charges; charge descriptions match the fee-head names.
- Admin `/exams` → Term 1 Examination listed as draft with four subjects and
  "4 with marks"; publishing succeeded and the row switched to published with a
  timestamp and Unpublish action.
- Admin `/staff` → five employees; `/notices` → three fresh published notices;
  `/reports` → fee head/class/method totals and three CSV download buttons;
  `/users` → six demo accounts.
- Teacher `/staff` → Leave tab only (no staff directory or salary), requested two
  days of leave, saw only their own request, then cancelled it while pending.
- Coordinator `/staff` → staff directory and all leave requests (no salary) and
  approved the remaining seeded request; the status changed to approved.
- Finance `/fees` → all write controls; `/reports` → live fee tables and exports;
  `/staff` → Leave tab only; `/users` → access denied.
- Auditor `/fees`, `/exams`, `/academic/timetable`, `/staff` → read-only views, no
  create/edit/publish/salary controls; `/users` → access denied.
- Parent `/portal` → two verified children, attendance, fees, and after publication
  the Term 1 report card (286/400, 71.50%, grade B1) with subject marks/grades; the
  portal showed only the `all` notice and not the staff-targeted or expired notice.
- The dashboard scoped correctly for teacher (2 students, 1 section) after a hard
  reload; the query cache is cleared on user switch and logout.
- No console errors on the checked pages.

The newer modules (safeguarding, leave configuration, payroll, late fees,
instalments, transcripts, CSV import, MFA/reset, idempotency, backup/restore)
were verified by the integration suite, typecheck, lint and production build.
They were **not** all re-clicked in a browser after the final database reset;
treat browser coverage of those screens as a follow-up, not as confirmed.

Test coverage highlights (all through Fastify + real PostgreSQL):

- login success/wrong password/session requirement/cross-origin block
- single-use password reset token, password replacement and session revocation
- TOTP enrolment, login challenge and disable
- idempotent payment/admission replay, mismatched payload rejection
- academic year validation and single-active activation
- section/year/class consistency, teacher denied writes + audit record
- admission number generation, duplicate rejection, single primary guardian
- guardian linking enabling portal visibility
- teacher section scoping, parent linked-child scoping, cross-school isolation,
  auditor read-only access
- dashboard aggregates for admin and teacher
- attendance register insert-only semantics, enrollment/date validation,
  section-scope and parent denials, auditor read-only access
- correction request/approval/rejection, one-pending-per-row conflict,
  self-approval denial, teacher approval denial, and unchanged original status
  until approval
- timetable section/teacher/room conflict rejection
- fee allocation limits, cross-student allocation denial, overpayment rejection,
  bulk generation, refund separation of duties and ledger totals
- late-fee posting to `LATE-FEE`, instalment plan creation and derived status
- printable invoice/receipt/transcript access controls and escaping
- exam mark validation, publication preconditions, marks locking and report-card
  grades; transcript totals with a `null` cumulative grade
- student CSV import success and per-row failures
- staff salary field restrictions and audit redaction, leave overlap/self-approval
  and own-record rules; configurable leave types and derived balances
- payroll draft/approve/paid flow with different-user approval and amount-free audit
- notice audience filtering, archive-before-delete, attachments, read receipts and
  role-derived visibility
- safeguarding permission gating and audit redaction
- report figures, duplicate-free CSV shape, section scoping for teachers and
  export audit records
- user creation, role/scope validation, last-administrator protection and session
  revocation on disable
- RLS policies under the restricted `erp_app` role with `app.school_id` set

## 5. Not implemented (explicit)

- Recruitment, appraisals and separation workflows beyond the staff status field.
- Statutory payroll rules (income tax, provident fund, insurance, gratuity);
  payroll deductions are entered explicitly and need client confirmation (D-030).
- Online payment capture and payment-gateway reconciliation. Printable invoices
  and receipts exist, but no gateway is integrated.
- Email/SMS/WhatsApp notice delivery, invitations and notification templates.
  Notice delivery is in-app only.
- Exam promotion/retention decisions and multi-term aggregation. Transcripts cover
  one academic year at a time.
- Parent-facing fee payment, leave requests, profile edits or document uploads.
- Safeguarding beyond case/notes recording: no external referrals, no automated
  escalation and no guardian communication.
- Full RLS enforcement at runtime. Policies and a restricted role exist and are
  tested, but the API connects as the owner (R-01).
- CI pipeline execution. A workflow is defined in `.github/workflows/ci.yml`, but
  there is no git remote and it has never run.
- SSO/identity-provider login, account self-registration and email delivery of
  password-reset links (the token is shown in-app outside production only).
- Automated browser-based accessibility (axe) and visual regression tests. Static
  `jsx-a11y` lint rules are enabled; full-page audits are not.

## 6. Final state

All functional phases targeted by this build are implemented **for the included
screens and endpoints**, with integration tests covering the server behaviour.
This includes academic structure, admissions/CSV import, guardians, enrollment,
attendance with corrections, timetables, fees with invoices/receipts/late
fees/instalments, examinations with report cards/transcripts, staff/HR with leave
configuration and payroll runs, notices with attachments/read receipts,
safeguarding cases, reports/CSV exports with audit records, users/roles,
password reset and TOTP MFA, a parent portal, JSON backup/restore, idempotency and
tested RLS policies. Every figure shown is computed from database rows, every
mutation is authorized server-side, and policy defaults that were not supplied by
the client are recorded in `CLIENT_DECISIONS.md` as provisional.

The repository is runnable end-to-end on a clean machine with Node 22+ and no
Docker. The product as a whole is **not production-ready**: it has no production
database or scheduled backup, RLS is not enforced by the running connection, CI has
never executed, and there is no payment gateway or outbound communication
delivery. Payroll statutory rules and several fee/exam/leave/notice/safeguarding
policies still need client confirmation.
