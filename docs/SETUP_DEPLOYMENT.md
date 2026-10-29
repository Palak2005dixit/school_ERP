# Setup, tests and deployment

## Local Windows/Linux development

Use Node 22+ and npm. Extract the source ZIP into a normal local directory. It deliberately excludes `node_modules`, `.env`, database files and generated bundles.

```sh
npm ci
```

Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell; `cp .env.example .env` on Linux). Then run from the repository root:

```sh
npm run db:setup
npm run dev
```

Open **http://localhost:5173**. API: http://localhost:4000/api/health. Embedded database: 127.0.0.1:5433. Run native PostgreSQL as a normal user, not root. `db:setup` seeds synthetic demonstration data; never use that seed for a live school database.

Synthetic logins: `admin@demo.test` / `Admin@12345`; `coordinator@demo.test` / `Coord@12345`; `finance@demo.test` / `Finance@12345`; `teacher@demo.test` / `Teacher@12345`; `parent@demo.test` / `Parent@12345`; `auditor@demo.test` / `Auditor@12345`. These are fixtures, not production credentials.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run test:portable
npm run build
npx playwright install chromium
npm run test:browser
```

`npm test` uses native embedded PostgreSQL. `test:portable` is cross-platform and selects the test-only PGlite SQL harness for restricted environments. It is not a production database, load test or native concurrency substitute. Browser tests start an isolated seeded API/database and Vite server; ports 4000/5173 must be free. Their data is disposable. Browser/axe execution did not succeed in the current environment; see the verification report.

## Environment

- `DATABASE_URL`: PostgreSQL connection URI; keep credentials out of committed files and logs.
- `PORT`, `APP_ORIGIN`: API port and exact browser origin. Production origin must be HTTPS.
- `NODE_ENV=production`, `COOKIE_SECURE=true`, `SESSION_TTL_DAYS`.
- `TRUST_PROXY=false` by default. Enable only behind a controlled reverse proxy with appropriate ingress restrictions.
- `NOTIFICATION_PROVIDER_URL`, `_TOKEN`, `_NAME`: approved external notification bridge; HTTPS and token required. See `INTEGRATIONS.md`.
- `PAYMENT_BRIDGE_URL`, `_TOKEN`, `_NAME`, `PAYMENT_WEBHOOK_SECRET`: approved payment bridge; the webhook secret must have at least 32 random characters.
- `SSO_ISSUER`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_REDIRECT_URI`: configuration only. SSO remains blocked until a provider adapter and account-linking policy are implemented and verified.
- `TEST_DATABASE_ENGINE=pglite`: tests only. Do not set this for production.

## Production target

No deployment was performed. Select a Node-compatible host and managed PostgreSQL; a static-only host cannot run this Fastify application. Keep database and attachments private, apply migrations with a separate migration account, verify runtime role grants, configure TLS/reverse proxy and exact origin, and set secrets through the host's secret manager.

Build the web application with `npm run build` and serve `apps/web/dist` with SPA fallback, proxying `/api` to Fastify. Start the existing TypeScript API with `node --import tsx apps/api/src/server.ts` from the repository root. The current API runtime requires `tsx`/workspace source dependencies; do not omit required development dependencies without first adding and verifying a compiled-server build. Configure a supervisor and health monitoring. Never run the demo seed in production.

Configure encrypted scheduled backups, retention, monitoring and a restore drill before live student data. Provider sandbox tests, native database tests, the blocked browser suite and the outstanding implementation list must be completed before claiming production readiness.
