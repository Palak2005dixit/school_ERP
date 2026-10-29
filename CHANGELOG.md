# Changelog

All notable implementation changes. Dates are local development dates.

## 2026-10-29 — extended modules, security hardening and docs

### Added — migrations 0011–0018

- `0011_notice_files.sql`: notice attachments and per-user read receipts.
- `0012_safeguarding.sql`: safeguarding cases and append-only case notes.
- `0013_leave_config.sql`: configurable leave types (quota, paid flag) and
  per-school holidays.
- `0014_payroll.sql`: payroll runs, payslips and payslip items with draft →
  approved → paid states.
- `0015_fee_plans.sql`: late-fee rules/assessments and instalment plans.
- `0016_auth_security.sql`: password-reset tokens and TOTP columns.
- `0017_idempotency.sql`: scoped idempotency keys for retry-safe writes.
- `0018_rls.sql`: RLS policies for tenant-scoped tables plus an optional
  restricted `erp_app` role.

### Added — API

- Safeguarding routes gated by `safeguarding.case.view` / `.manage`; summaries and
  note text are excluded from audit payloads.
- Leave configuration, derived balances and holidays; Staff page gains a Leave
  setup tab.
- Payroll run creation, different-user approval, mark-paid and payslip reads;
  amounts are excluded from audit state.
- Late-fee rule/run, instalment plans, and printable invoice/receipt/transcript
  HTML rendered server-side with escaped output.
- Student transcript JSON for staff and guardians; cumulative grade is `null` by
  design.
- `POST /students/import`: RFC 4180 CSV, 500-row cap, per-row transactions and a
  metadata-only import audit event.
- Password forgotten/reset (single-use expiring token, session revocation) and TOTP
  MFA setup/enable/disable; login accepts `totpCode`.
- Optional `Idempotency-Key` on payment, admission and payroll-run creation.
- CSV exports now write a `reports.exported` audit event (report name and row
  count only).
- `db:backup` / `db:restore` JSON snapshot helpers (restore local-only, `--yes`,
  truncates data tables first).

### Added — web

- `/safeguarding` page and navigation entry (permission-gated).
- Staff page tabs for leave setup and payroll.
- Fees page "Late fees & instalments" tab, plus invoice and receipt links.
- Students page CSV import dialog with academic-year picker, file/paste input and
  per-row results.
- Login page forgot/reset password and MFA code entry; profile page MFA card.
- Parent portal printable invoice, per-payment receipts and printable transcript.
- Exams report-card dialog "Print transcript" and "Transcript (JSON)" actions.
- Route-level code splitting via `React.lazy` + `Suspense`.

### Changed

- `eslint-plugin-jsx-a11y` added to the ESLint flat config for `apps/web`.
- Parent role no longer holds staff `fees.view` / `exams.view`; portal endpoints
  use `guardian.student.view`.
- Seed extended with leave types/holidays, a late-fee rule, an instalment plan, an
  approved September 2026 payroll run with payslips, a synthetic safeguarding case
  and updated counters.

### Fixed

- MFA invalid-code path no longer triggers PostgreSQL `42P08` (lockout timing is
  computed in JS).
- Several screens referenced `schools.address`; the query now selects
  `NULL::text AS address` for printable documents.
- `jsx-a11y` label violations fixed in the student search bar and leave holiday
  year field.

### Verified

- `npm run typecheck` — pass across 5 workspaces.
- `npm run lint` — pass (0 problems, including jsx-a11y).
- `npm test` — **70/70 integration tests** (~48 s).
- `npm run build` — pass (main JS `317.50 kB` / `99.94 kB` gzip, CSS `37.36 kB` /
  `7.27 kB` gzip; no chunk warning).
- `npm audit` — 0 vulnerabilities.
- `npm run db:reset` — 18 migrations applied and reseeded.
- Documentation reconciled: `README.md`, `IMPLEMENTATION_STATUS.md`,
  `REQUIREMENT_TRACEABILITY.csv`, `CLIENT_DECISIONS.md` (D-028–D-036) and
  `KNOWN_RISKS.md` (R-01, R-04–R-06, R-12–R-13, R-18–R-26).
- Newer screens were verified by tests/build; not all were re-clicked in a browser
  after the final reset (recorded as a limitation, not a pass).

## 2026-10-29 — operational modules

### Added

- Migrations `0006_timetable.sql` … `0010_notices.sql`: timetable periods,
  rooms and slots (with unique section/teacher/room conflict indexes); fee heads,
  structures, charges, payments, allocations and refunds; grading schemes/bands,
  exams, exam subjects and marks; staff, salaries and leave requests; notices.
- API modules `timetable.ts`, `fees.ts`, `exams.ts`, `staff.ts`, `notices.ts`,
  `reports.ts` and `access.ts`, all registered behind permission guards and
  school/section scope.
- `/academic/timetable` page: weekly grid plus period/room management and
  conflict-aware slot dialogs.
- `/fees` page: overview totals, charges, payments, refunds, fee heads/structures
  and per-student ledger; bulk charge generation; allocation-based receipts.
- `/exams` page: grading schemes, exams, subjects, section marks and report cards;
  publish/unpublish with mark locking.
- `/staff` page: permission-gated staff directory, salaries and leave
  request/approval tabs; leave-only users open directly on Leave.
- `/notices` page with status/audience filters and publish/unpublish/archive.
- `/reports` page with live attendance, fee-by-head/class/method and roster
  tables plus server-generated CSV downloads.
- `/users` page for account creation, role/scope assignment, disable/lock and
  last-admin protection.
- Parent portal expanded with per-child attendance, fee ledger/receipts, published
  report cards and guardian-audience notices.
- Operational seed: periods/rooms/20 slots, fee heads/structures/charges/payments
  and a pending refund, grading scheme + 8 bands, a draft Term 1 exam with marks,
  five staff with salaries and leave requests, and four notices.
- `requireAnyPermission` guard and `RequireAnyPermission`/`GuardAny` UI guards so
  `/staff` is reachable by staff, salary or leave permissions independently.
- `LinkButton` for server-download anchors and `formatClock` for `HH:MM` times.

### Fixed

- Update schemas no longer use `.partial()` over input schemas, which leaked Zod
  defaults into omitted PATCH fields.
- `access.ts` user-status update used an untyped `$2`, causing PostgreSQL type
  inference failures; it now casts `$2::text`.
- Role switches and sign-out clear the auth/query cache so the previous user's
  records cannot flash for the next user.
- Academic structure GETs accept `school.view` as well as
  `academic.structure.view`, so finance/report pickers load without granting
  academic navigation.
- Seed charge descriptions now use the bare fee-head name (no duplicated "fee").
- Timetable period times render as `HH:MM` instead of `HH:MM:SS`.
- Staff page no longer issues the staff-list query for leave-only users.

### Verified

- `npm run check` — typecheck across 5 workspaces, ESLint 0 problems,
  **48/48 integration tests**.
- `npm run build` — pass (`549.41 kB` JS / `148.05 kB` gzip; non-fatal single-chunk
  warning above 500 kB).
- `npm audit` — 0 vulnerabilities.
- `npm run db:reset` — 10 migrations applied; seed completes with the operational
  data set.
- Browser verification across admin, coordinator, teacher, finance, auditor and
  parent: timetable, fees totals, exam publish → portal report card, staff/leave
  request → approval, notices audience filtering, reports, users, and permission
  denials (`/users` denied to finance/auditor, salary hidden from non-admins).
- Documentation reconciled: `IMPLEMENTATION_STATUS.md`, `README.md`,
  `REQUIREMENT_TRACEABILITY.csv`, `CLIENT_DECISIONS.md` (D-014–D-027) and
  `KNOWN_RISKS.md` (R-06–R-21).

## 2026-10-29

### Added

- Phase 0 documentation: `README.md`, `IMPLEMENTATION_STATUS.md`,
  `REQUIREMENT_TRACEABILITY.csv`, `CLIENT_DECISIONS.md`, `KNOWN_RISKS.md`.
- Seeded synthetic `activity_events` and `audit_events` for the demo admissions,
  so the dashboard timeline and audit screen are meaningful on a fresh database.
- `useSchoolTimezone` and timezone-aware rendering of instants/dates
  (`formatDateTime`, `todayIso`) using the membership's school timezone.
- ESLint 9 flat configuration covering TypeScript in all workspaces.
- GitHub Actions verification workflow (`.github/workflows/ci.yml`), not yet run.
- Regression assertion that the admin dashboard exposes seeded admissions.

### Added — attendance slice

- Migration `0005_attendance.sql`: `attendance_corrections`, composite
  school-scoped FK to `student_attendance`, review-state check, one pending
  correction per attendance row, and lookup indexes.
- `attendance.register.view` permission granted to admin, coordinator, teacher and
  auditor; `attendance.correction.approve` to admin and coordinator (teacher keeps
  `attendance.student.record`).
- Attendance API: daily register read/save (insert-only, enrollment and
  school-timezone date validation), correction request, pending queue and
  approve/reject review with self-approval denial and transactional audit.
- `/attendance` page with year/section/date selection, draft entry, mark-all-present,
  locked saved rows, correction dialog and approver queue with review dialogs.
- 10 integration tests covering register semantics, scoping, date validation
  (including impossible calendar dates), correction lifecycle and read-only
  auditor access (29 total).

### Fixed

- Wrong-password login returned HTTP 500 because PostgreSQL inferred conflicting
  types for `$2` in the failed-attempt `UPDATE`; the query now computes
  `locked_until` in TypeScript with explicit parameters.
- Test database port collisions: the throwaway cluster now asks the OS for a free
  loopback port instead of always binding 5434.
- Removed the deprecated Fastify `disableRequestLogging` option (FSTDEP023).
- Removed the unused `SEED_DEMO_DATA` environment flag instead of leaving a
  configuration knob that did nothing.
- DATE values were formatted with `toISOString()`, which shifted the calendar day
  in positive-offset timezones; `toIsoDate` now formats the local components that
  node-postgres parsed the DATE into.
- `isoDate` accepted impossible dates such as `2026-02-30`, which reached
  PostgreSQL and surfaced as a 500; the shared schema now validates real calendar
  dates (leap years included) before the query runs.

### Changed

- Upgraded Vitest 3 → 4.1.12 (and migrated the config off removed
  `poolOptions`), clearing 1 moderate + 2 critical dev-dependency advisories.
- `npm audit` now reports 0 vulnerabilities.
- Rebuilt the local demo database from scratch to remove manual UI-test artifacts;
  browser-verified admin dashboard/audit and the parent portal afterwards.

### Verified

- `npm run typecheck` — pass (api, web, core, db, shared)
- `npm run lint` — pass (0 problems)
- `npm test` — 29/29 integration tests pass
- `npm run build` — pass (411.72 kB JS / 120.71 kB gzip)
- Browser verification — teacher register save, correction request, coordinator
  approve/reject, auditor read-only, parent denial, attendance audit events; no
  console errors

## 2026-10-28 / 2026-10-29 — Initial build

### Added

- Monorepo scaffold (`apps/api`, `apps/web`, `packages/shared`, `packages/core`,
  `packages/db`) with npm workspaces and strict TypeScript.
- Migrations 0001–0004: identity/roles/sessions/audit, academic structure,
  students/guardians/enrollments/attendance tables, integrity indexes.
- Idempotent synthetic seed and embedded PostgreSQL dev/test helpers.
- Fastify API: auth, academic CRUD + activation, admissions, student
  list/detail/edit, guardian linking, enrollment, parent portal, overview,
  audit events.
- React SPA: login, app shell, dashboard, academic pages, students list,
  admission form, student detail, audit log, parent portal, profile/password,
  404, dialogs and toasts.
- Integration test suite (19 tests) covering auth, scoping, validation and audit.
