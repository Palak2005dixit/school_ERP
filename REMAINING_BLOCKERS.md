# Genuine external blockers — 29 October 2026

Unfinished internal code is listed in `REMAINING_WORK.md`, not here.

| Blocker | Evidence / impact | Required next action |
|---|---|---|
| Native PostgreSQL process identity | Native `npm test` fails because PostgreSQL refuses UID 0. `/proc/self/uid_map` contains only UID 0; an unmapped non-root identity cannot be selected. Creating a postgres user also fails in this restricted namespace | Run `npm ci && npm test` as a normal user on Windows/Linux or provide a native PostgreSQL test host; repeat concurrency and upgrade validation |
| Chromium download | `npx playwright install chromium` repeatedly downloads truncated/non-ZIP data. `npm run test:browser` starts the test API/web servers but all 11 checks fail at browser launch: executable missing | Install Playwright Chromium on a host with working browser-download access, then run the 11 browser/axe checks |
| Notification provider | No approved URL/token/provider supplied; messages remain BLOCKED when absent | Set `NOTIFICATION_PROVIDER_URL`, `NOTIFICATION_PROVIDER_TOKEN`, `NOTIFICATION_PROVIDER_NAME`; confirm privacy, consent, costs, retry/idempotency semantics and real delivery |
| Payment provider | No approved bridge or verified gateway credentials supplied; no real capture/refund/settlement tested | Configure `PAYMENT_BRIDGE_URL`, `PAYMENT_BRIDGE_TOKEN`, `PAYMENT_BRIDGE_NAME`, `PAYMENT_WEBHOOK_SECRET`; validate the bridge contract in provider sandbox before production |
| SSO provider and account linking | No approved IdP/issuer/client/redirect/account-linking rules; typed interface is intentionally not a login | Select IdP and account-linking policy; supply documented SSO variables and verify a provider-specific OIDC adapter |
| School operating policies | Attendance thresholds/calendar/overtime, payroll rules, approval thresholds, borrowing/fines, concessions, retention and SLA decisions are not confirmed | Confirm policy values in `CLIENT_DECISIONS.md`; configured provisional values are not statutory or client-approved rules |
| Deployment and recovery target | No production host/database/secret store, backup schedule, RPO/RTO or deployment access supplied | Configure the selected target and recovery requirements; perform deployment verification and isolated restore drill |
| CI execution | No Git repository/remote was supplied with the archive | Attach the source to the intended remote and execute the supplied CI workflow |
