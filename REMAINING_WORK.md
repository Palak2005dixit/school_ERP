# Remaining code and verification work

These are implementation gaps, not requests for credentials and not hidden inside the blocker list. The overall mission is not complete.

1. Workforce: complete recurring generation scheduling and policy-approved payroll adjustment rules after school confirmation. Configured duration thresholds, explicit working-day generation and review-only attendance/leave payroll source data are now connected; no statutory deductions were invented.
2. Recruitment: implement scheduled future changes, actual campus/role transfer application, onboarding task/document links, and configured retention/legal-hold execution. Current future-dated changes fail clearly instead of applying early.
3. Procurement: extend independent-approval count to policy-defined role/threshold stages; complete PO amendment versioning and connect draft amendment controls in the UI. Existing vendor bill payment is an operational record, not a general-ledger posting.
4. Transport: effective-period conflict checks across driver/attendant/vehicle schedules, future allocation transitions, vehicle-capacity changes and fee assessments. Current fee-head association does not automatically create student charges.
5. Library: reservation hold/expiry automation, broader member eligibility, and approved fine/fee-ledger mapping. Existing manual fine recording does not imply gateway collection.
6. Learning: assessment/question-bank links and the full file authorization/browser test matrix. Dedicated student identity/self-submission, verified guardian submissions, class-filtered resources and private downloads are implemented; the student portal as a whole is not claimed complete.
7. Cases: configurable timed escalation workers, richer transition policies and negative tests for every internal attachment/note path. Generic cases and safeguarding remain separate.
8. Communications: complete password-reset/invitation delivery integration, event-specific recipient targeting and template-variable editing UI. The outbox/provider abstraction and deterministic delivery tests are present. User-requested approved provider selection/credentials are separate blockers.
9. Finance: complete gateway payout settlement and receipt/ledger consistency checks; add a full financial concurrency matrix, concession edge cases and refund/settlement state transitions. Verified gateway events never auto-create receipts.
10. Reports/imports: exhaustively validate imported field lengths/types against all target schemas, complete duplicate strategies beyond exact-row/stable-ID checks, and add durable asynchronous jobs/recovery for operations above the current 500-row/5,000-export-row caps.
11. Identity: implement full campus/department/custom record scopes; unsupported section mappings fail closed. Complete production separation/account lifecycle audit and provider-specific SSO adapter after IdP/policy selection.
12. Readiness: run native PostgreSQL upgrade/race tests and all browser/axe scenarios once the environment is available; address findings, conduct a production restore drill and validate deployment. No full accessibility/DR/production-readiness claim is made.

## Exact next task

Continue with assessment/question-bank linking (item 6), then procurement amendment/versioning and role/threshold approval chains (item 3), maintaining existing 33 migration checksums and the current regression suite. Use `npm run test:portable` here; use native `npm test` on a normal non-root host. Do not restart from a new scaffold or assume the older baseline document is current.
