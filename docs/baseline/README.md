# Greenfield School ERP

A working, self-hosted School ERP built incrementally from the supplied planning
bundle. It currently covers **identity and access (including password reset and
TOTP MFA), academic structure, student admissions and CSV import, guardians,
enrollment, daily attendance with an approval-based correction workflow,
timetables, fees and invoices/receipts/instalments/late fees, examinations,
report cards and transcripts, staff/HR with leave configuration and payroll runs,
notices with attachments and read receipts, safeguarding cases, reports/exports,
user administration, a read-only parent portal, a real dashboard, JSON
backup/restore, and an append-only audit log**.

This is a real application, not a mockup: every dashboard figure is computed from
database rows, every mutation is authorized on the server, and every seeded
record is synthetic.

> **Scope honesty:** this is not a complete School ERP. Recruitment, appraisals,
> separation workflows, statutory payroll rules, online payment capture and
> email/SMS/WhatsApp delivery are **not implemented** and need provider
> credentials or confirmed policy. RLS policies exist and are tested, but the
> running API still connects as the database owner, so tenant isolation continues
> to depend on application code. CI has never run because there is no git remote.
> Several fee/exam/leave/notice/safeguarding policies are configurable defaults
> that still need client confirmation. See
> [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md),
> [CLIENT_DECISIONS.md](CLIENT_DECISIONS.md) and
> [KNOWN_RISKS.md](KNOWN_RISKS.md) before treating any part as production-ready.

## What works today

| Area | Implemented |
| --- | --- |
| Authentication | Email + password (scrypt), httpOnly session cookie, login rate limit, account lockout after 10 failures, change-password with session revocation, single-use password reset, TOTP MFA setup/disable |
| Authorization | Canonical permission catalogue, role assignments with school/section/linked-student scope, server-side guards, denied attempts audited |
| School setup | School profile, campuses, academic years (single-active enforcement), classes, sections, subjects |
| Admissions | Student creation with auto-generated admission number, guardian creation/linking, enrollment, status and profile edits, 500-row CSV import with per-row errors |
| Attendance | Daily register per section/date, present/absent/late/half-day/excused, saved rows immutable, correction requests approved by a different user |
| Timetable | Periods, rooms and weekly slots with database-enforced section/teacher/room conflict checks |
| Fees | Fee heads/structures, bulk charge generation, concessions, allocated payments with receipts, refunds requiring a different approver, derived balances, late-fee rules/runs, instalment plans, printable invoices and receipts |
| Examinations | Grading schemes/bands, exams and subjects, mark entry, publication preconditions, locked marks, report cards and printable/JSON transcripts |
| Staff & HR | Staff directory, auto employee numbers, restricted salary, leave requests/approval, configurable leave types/quotas/holidays with derived balances, payroll runs with payslips and different-user approval |
| Notices | Draft/publish/archive, role-derived audience targeting, expiry/pinning, attachments (max 1 MiB) and per-user read receipts |
| Safeguarding | Restricted case records with notes, status/severity tracking and reads/changes audited without copying note text |
| Reports | Live attendance and fee reports plus server-generated, scope-aware CSV exports recorded in the audit log |
| Users & roles | Account creation, role/scope assignment, disable with immediate session revocation, last-admin and self-disable guards |
| Parent portal | Verified guardians see only their linked children (read-only): attendance, fee ledger/receipts/invoice, published report cards/transcript and parent notices |
| Dashboard | Live counts scoped to the viewer, students by class, seeded activity timeline |
| Audit | Append-only `audit_events` + `activity_events`, admin/auditor audit page with pagination |

Routes and screens are listed in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Stack

- **Web:** React 19, TypeScript, Vite 7, Tailwind CSS v4, React Router 7,
  TanStack Query 5
- **API:** Fastify 5, Zod 4, `pg`, scrypt from `node:crypto`
- **Database:** PostgreSQL 18 via [`embedded-postgres`](https://github.com/leinelissen/embedded-postgres)
  (no Docker required), versioned SQL migrations
- **Tests:** Vitest 4 integration tests against a throwaway real PostgreSQL cluster
- **Quality:** TypeScript strict mode, ESLint 9 flat config, Prettier

No paid services or cloud dependencies are used. PostgreSQL binaries are fetched
by the `embedded-postgres` package on first install.

## Requirements

- Node.js **22 or newer** (verified on Node 25.4 / npm 11.7)
- No system PostgreSQL, Docker, or database server is required for development
- Disk space for the embedded PostgreSQL binaries and `.pgdata/` (hundreds of MB)

## Quick start (Windows PowerShell)

```powershell
Copy-Item .env.example .env
npm install
npm run db:setup     # boots embedded PostgreSQL if needed, applies migrations, seeds synthetic data
npm run dev          # starts database, API (4000) and web (5173) together
```

Open <http://localhost:5173> and sign in with a demo account below.

`npm run db:setup` starts the embedded cluster only for the command if nothing is
listening on `127.0.0.1:5433`; data persists in `.pgdata/`. `npm run dev` then
starts the same cluster and keeps it running.

### Demo accounts (synthetic data only)

| Email | Password | Role | Scope |
| --- | --- | --- | --- |
| `admin@demo.test` | `Admin@12345` | Main Administrator | Whole school; every module, users/roles, salary |
| `coordinator@demo.test` | `Coord@12345` | Academic Coordinator | Whole school; academic, attendance approval, exams, staff directory and leave approval (no salary) |
| `teacher@demo.test` | `Teacher@12345` | Teacher | Grade 1 · Section A only; attendance, marks, own leave |
| `finance@demo.test` | `Finance@12345` | Finance | Fees, refunds, reports/exports, own leave |
| `parent@demo.test` | `Parent@12345` | Parent / Guardian | Aarav Sharma and Diya Sharma only; read-only portal |
| `auditor@demo.test` | `Auditor@12345` | Auditor | Read-only across modules + audit log |

The seed creates Greenfield Public School, 5 classes, 10 sections, 6 subjects,
6 students, guardians and enrollments. It also seeds timetable periods/rooms and
20 weekly slots, fee heads/structures/charges/receipts, a late-fee rule, an
instalment plan, a grading scheme, a draft Term 1 exam with marks, five staff
records with salaries and leave requests, leave types/holidays, an approved
September 2026 payroll run, a synthetic safeguarding case, and four notices. It
is idempotent and never touches a database that already has students.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run database + API + web with hot reload |
| `npm run dev:db` | Run only the persistent embedded PostgreSQL cluster |
| `npm run db:setup` | Migrate + seed (first run) |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Insert/refresh synthetic demo data |
| `npm run db:reset` | **Destroys local data**, recreates schema, migrates and seeds |
| `npm run db:backup [file]` | Write a JSON snapshot of all data tables (local tooling) |
| `npm run db:restore <file> --yes` | Restore a JSON snapshot; local databases only and truncates first |
| `npm test` | Integration test suite (real embedded PostgreSQL, random free port) |
| `npm run typecheck` | TypeScript across all workspaces |
| `npm run lint` | ESLint across the repository |
| `npm run check` | typecheck + lint + tests |
| `npm run build` | Production build of the web app into `apps/web/dist` |
| `npm run format` | Prettier write |

## Repository layout

```
apps/
  api/                Fastify API, auth guards, routes, audit helpers
  web/                React SPA (pages, shell, query hooks, API client)
packages/
  core/               Password hashing and authorization/scoping helpers
  db/                 Migrations, seed, embedded PostgreSQL, DB CLI
  shared/             Zod schemas, shared types, permission catalogue
```

Request flow: browser → Vite proxy → Fastify → permission guard → scoped SQL →
PostgreSQL. The browser never talks to the database directly, and database
credentials never reach the web bundle.

## Security model (implemented)

- Sessions are stored server-side (`sessions` table, SHA-256 token hash) and
  delivered in an httpOnly, SameSite=Lax cookie. `Secure` is opt-in via
  `COOKIE_SECURE=true` for HTTPS deployments.
- Every protected endpoint runs a permission guard, and queries additionally
  apply school/section/linked-student scope. Failures return 403 and are written
  to the audit log with the missing permission.
- Mutating requests with a cross-site `Origin` are rejected (CSRF defence).
- Login is rate-limited; repeated failures lock the account for 15 minutes.
- Passwords are hashed with scrypt and a per-password salt; login always performs
  a hash comparison to avoid user-enumeration timing leaks.
- Password reset uses a single-use, expiring token (never the password itself),
  and a successful reset revokes every existing session.
- TOTP two-factor authentication can be enrolled, confirmed and disabled only
  after re-entering the account password and a current code.
- Payment, admission and payroll-run creation accept an optional
  `Idempotency-Key` header; replays return the stored response and mismatched
  payloads are rejected.
- Sensitive mutations (fees, exams, HR, notices, safeguarding, access) write
  audit records. Amounts, secrets and safeguarding note text are excluded from
  audit payloads. CSV exports append a metadata-only `reports.exported` record.
- Audit and activity tables are append-only (enforced by a database trigger).
- Errors returned to clients are sanitized; SQL and stack traces stay in server
  logs.

RLS policies exist for every tenant-scoped table in migration `0018_rls.sql`, and
an integration test verifies them by switching to the restricted `erp_app` role
with `app.school_id` set. The running API currently connects as the database
owner, which bypasses RLS, so tenant isolation still depends on the application
query scopes. Running the API as `erp_app` with per-request `app.school_id`
transaction context is a deployment-hardening task, not something this local
build does. See [KNOWN_RISKS.md](KNOWN_RISKS.md).

## Tests

```powershell
npm test
```

The suite boots a disposable embedded PostgreSQL cluster on a free loopback port,
applies all migrations, seeds the demo data, and exercises HTTP flows through
Fastify (`app.inject`). It covers positive and negative authorization:
teacher section scoping, parent linked-child scoping, cross-school isolation,
auditor read-only access, duplicate admissions, primary-guardian uniqueness,
single-active-year enforcement, denied-write auditing, attendance register
insert-only behaviour, date-range validation, and the correction approval
separation (including self-approval denial). It also covers timetable
section/teacher/room conflicts, fee allocation limits and refund separation of
duties, exam publication preconditions and mark locking, staff salary
redaction/leave rules, notice audience filtering and read receipts, report
figures and CSV shape, and user/role administration guards.

Newer coverage adds single-use password reset with session revocation, TOTP
enrolment/challenge/disable, idempotent payment and admission replays, student
CSV import (success and per-row failure), late-fee posting, instalment plans,
printable invoices/receipts/transcripts, payroll run approval separation, leave
type configuration and derived balances, safeguarding access restrictions,
JSON-format RLS policy checks, and the backup/restore helpers.

Current result (2026-10-29): **70 passed / 70**, typecheck clean across 5
workspaces, ESLint 0 problems (including `eslint-plugin-jsx-a11y` static
accessibility rules for the web app), web production build succeeds
(`317.50 kB` main JS / `99.94 kB` gzip after route-level code splitting), and
`npm audit` reports 0 vulnerabilities. `npm run db:reset` applies 18 migrations
and reseeds the demo school.

Static a11y linting is not a substitute for a browser-based audit (keyboard
traversal, focus order, contrast, screen-reader announcements). No automated
full-page a11y test exists yet; see [KNOWN_RISKS.md](KNOWN_RISKS.md).

## Documentation

- [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) — what is built, verified,
  and deliberately deferred, with commands and evidence
- [REQUIREMENT_TRACEABILITY.csv](REQUIREMENT_TRACEABILITY.csv) — requirement →
  module/route → permission → test → status
- [CLIENT_DECISIONS.md](CLIENT_DECISIONS.md) — provisional assumptions that need
  school-client confirmation
- [KNOWN_RISKS.md](KNOWN_RISKS.md) — security, operational and scope risks
- [CHANGELOG.md](CHANGELOG.md) — implementation history

## Environment variables

See [.env.example](.env.example). Defaults are for local development:

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5433/school_erp` | Local embedded cluster |
| `PORT` | `4000` | API port |
| `APP_ORIGIN` | `http://localhost:5173` | Allowed browser origin / CORS-equivalent check |
| `SESSION_TTL_DAYS` | `7` | Session lifetime |
| `COOKIE_SECURE` | `false` | Set `true` only behind HTTPS |

Never commit `.env`; it is already ignored. No secrets are stored in source.
