# Working with the extended ERP workflows

Use the existing Users screen to grant the appropriate permissions. Hiding a button is not the authorization control; the server rechecks access.

## Staff attendance

Open **Staff attendance**. Configure a shift and its grace/break times. Assign it to a staff member with effective dates; assignments may not overlap. To change an assignment, select an Effective to date and end the old assignment before creating the next one.

Use Punch in/out for live server-time records or Record attendance for historical records. Duplicate punches and repeated daily-register saves are rejected. Saved records must use the correction/independent approval workflow. Missing punches remain explicit exceptions. Punches must belong to the work date in the school timezone; future dates/times are rejected.

Duration classification starts disabled when no settings exist. Explicitly enable it only after confirming full-day/half-day thresholds. Shift grace, break and overtime settings are configurable, not statutory payroll rules. Approved leave is checked before manual leave/absence entries.

For completed periods, Generate missing absences requires explicit working-day selection and confirmation. It excludes holidays, approved leave and existing records and accepts at most 31 days. Repeating the same run does not duplicate records. The Summary view provides a payroll source review with raw punch minutes/calendar leave days; it never calculates pay or deductions.

## Recruitment and employee lifecycle

Open **Recruitment**. Create a vacancy, candidate and interview; record the evaluation. Create and submit an offer. A different authorized approver must approve it, then record acceptance before Hire. Hiring creates one staff record and onboarding tasks; repeating it is rejected.

The private-document panel uploads PDF, JPEG, PNG or text files up to 1 MiB against the candidate/staff ID, lists their review state and allows protected download. Document retention/deletion is not automatic. Employee changes create audited history; future changes are rejected until their effective date. Separation requires an independent approval and completion/cancellation of exit tasks. Completing it revokes the affected school membership and sessions while preserving shared identities for other schools. Last-administrator protection applies.

## Procurement

Create vendors and budgets, enter itemized requests and submit them. The requester cannot approve their own request. The school administrator can configure 1–5 independent approvers; one person cannot approve the same request twice. This count applies to pending/future requests and requires confirmation. It is not yet a role/amount threshold chain.

Approved requests feed the existing PO workflow. Receive items with discrepancies, record/review bills and expenses, and review budget utilization. An expense cannot be reviewed by its creator or exceed the available budget. A draft request amendment API exists; full PO amendments and amendment UI remain listed as unfinished work.

## Transport

Set up vehicles, drivers, routes and stops; assign students to stops. Duplicate current allocations and full vehicles are rejected. End allocations to preserve history. Maintenance is an operational record. The fee-head association does not itself assess a transport charge. Verified guardians can see only their child's current route/stop/pickup/drop/vehicle details in the parent portal. No GPS tracking is represented as live.

## Library

Create books/copies and members, configure limits/fines and issue an available copy. Issue/return/renew changes actual inventory. A copy cannot be issued twice. Waiting reservations prevent renewal. Return condition supports lost/damaged records. Fines are recorded by authorized staff; no external payment is implied. Circulation/member/fine history requires school-wide library access; section-scoped teachers may browse the catalogue.

## Learning and student accounts

Create resources/homework with section, subject, availability, due date and marks settings. Publish before accepting submissions. Resubmission follows the configured flag; grades cannot exceed the assignment maximum. Teachers are constrained to assigned sections. Question-bank answers are staff-only. Private submission downloads recheck teacher/student/guardian access.

For independent student access, create a dedicated account with the Student role in Users, then open the student's detail page and use Student login account to link it. Staff/guardian accounts cannot be reused as the dedicated student login in that school. The student can list their own assignments and submit only for themselves. Removing the link revokes the student role/sessions. Verified guardians can still submit for their linked children. The Learning learner picker serves both identity types. Resource class targeting is enforced for learner lists/downloads.

## Concerns and safeguarding

Use categories to configure priority/SLA, then open a concern. Managers with assignment authority can assign, escalate and resolve; requesters see their own cases and public updates. Internal notes/attachments are not requester updates. Safeguarding is a separate protected module and never appears in the generic case export.

## Notifications

Preferences record linked-user channel consent. For external recipients, record consent evidence before queueing. Configure only an approved provider. Missing configuration creates BLOCKED; a queued/test message is not a sent message. Review outbox attempts, retry status and diagnostics. A provider acknowledgement does not prove recipient reading/delivery. See `INTEGRATIONS.md`.

## Fees and reconciliation

Use Fee controls to request concessions, obtain independent approval and record explicitly authorized write-offs. Match bank statement lines to existing payments; mismatched amounts remain exceptions. Resolve unmatched/exception lines before closing a batch. Gateway events are separate verified evidence and must be linked to an existing valid ERP receipt; they never auto-post money. The current fee ledger is INR; no currency conversion is invented.

## Imports and reports

Data tools supports CSV preview, errors and explicit commit. Only valid rows are committed in one transaction. Duplicate rows and previously imported exact rows are rejected; repeated commits do not create duplicates. Imports are capped at 500 rows. Saved report filters run predefined authorized report exports. Reports also offers date-filtered operational CSVs, capped at 5,000 rows; exports are audited and require school-wide permission for that module.

## Recovery

Read `MIGRATIONS_RLS.md` before using backup/restore. JSON contains sensitive database records and private attachments, not merely a public export. Restore is an explicit local administrative operation and replaces target data atomically. Production scheduling/encryption/restore verification remains an operator responsibility and an unresolved deployment requirement.
