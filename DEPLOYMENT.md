# Deployment Guide

This document describes how to deploy the MSP PSA application on the MSP's own self-hosted infrastructure using Docker Compose. It reflects the application's state as of the end of Phase 6 (Polish & Launch Prep) and is written to be followed top to bottom on a fresh host.

Every command below matches a real script in `package.json`, a real Docker Compose command, or a real file in this repository — nothing here is aspirational.

---

## Prerequisites

- **Docker** and **Docker Compose** (the `docker compose` plugin, v2 syntax — not the legacy standalone `docker-compose` binary) installed on the target host.
- **Node.js 20.19+** (matching this project's pinned `node:20.20` in `Dockerfile`; 22.12+ or 24+ also work) installed on the host itself — required for the host-side tooling described in "Database migration" below (`npm install`, `npm run db:migrate:deploy`, `npm run test:e2e`). This is separate from the Node.js version used *inside* the Docker images, which is pinned by `Dockerfile` and doesn't depend on the host. Prisma 7 refuses to install on an older Node with a clear `Prisma only supports Node.js versions 20.19+, 22.12+, 24.0+` error — check with `node --version` first. On a fresh Debian/Ubuntu host (a common case: the OS-default `apt` package is often too old), install a current Node.js via NodeSource:

  ```bash
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt install -y nodejs
  ```

  For other distros/OSes, use [nvm](https://github.com/nvm-sh/nvm) or the official installer from [nodejs.org](https://nodejs.org).
- Git access to clone this repository.
- Outbound network access from the host to:
  - Microsoft Graph API (`login.microsoftonline.com`, `graph.microsoft.com`) if the email-to-ticket poller will be used.
  - Intuit's QuickBooks Online API (`sandbox-quickbooks.api.intuit.com` or `quickbooks.api.intuit.com`, and `appcenter.intuit.com` for the OAuth flow) if QuickBooks integration will be used.

### Network / firewall considerations

`docker-compose.yml` publishes exactly two host ports:

- `3000` (the `app` service — the web UI and all API routes, including auth).
- `${DB_PORT:-5432}` (the `db` service — Postgres). This port only needs to be reachable from the host itself and from any Postgres client the operator uses for direct maintenance; it should **not** be exposed to the internet.

The `email-poller` service exposes no ports (it is an outbound-only polling process).

**Only port 3000 should ever be internet-reachable, and only if the MSP has a specific reason to expose this application outside its internal network.** Before doing so, be aware of the following, introduced in this phase:

- **Rate limiting exists but is basic.** `src/middleware.ts` applies an in-memory, IP-keyed fixed-window rate limiter: 60 requests/60s per IP for general routes, and a tighter 10 requests/60s per IP for `/api/auth/*` (the login/credential-check surface). This is a brute-force speed bump appropriate for a small internal tool, **not a production-grade or distributed rate limiter** — it is per-process, resets on container restart, and provides no protection if the app is scaled to multiple instances behind a load balancer (each instance would track its own independent counters, effectively multiplying the real limit by instance count). If this app is ever exposed to the public internet, put it behind a reverse proxy (e.g. Caddy, nginx, or a cloud provider's WAF) with its own independent rate limiting/DDoS protection rather than relying on this limiter alone. Note also that the limiter keys on the client IP it reads from request headers (`X-Forwarded-For`/`X-Real-IP`) — it only provides real protection when the app sits behind a reverse proxy that sets those headers itself and strips/overwrites any client-supplied values; without a trusted proxy in front, a client can forge those headers and bypass the per-IP limit entirely.
- For an internal-network-only deployment (the default assumption for this app, an "in-house PSA platform"), the built-in limiter is a reasonable defense-in-depth layer against a compromised internal host or a misbehaving script, not the primary control.

---

## First-time setup

1. **Clone the repository** onto the target host and `cd` into it.

2. **Copy the environment template**:

   ```bash
   cp .env.example .env
   ```

3. **Fill in every variable in `.env`**, group by group:

   **Database connection**
   - `DB_PORT` — the host port Postgres will be published on. Default `5432` is fine for a single production instance. Only change this if you are running multiple instances of this stack (e.g. staging alongside production) on the same host — see "Operational notes" below.
   - `DATABASE_URL` — must match `DB_PORT` (the host-side connection string used by tooling run outside Docker, e.g. `npm run db:migrate:deploy` from the host). Note that the `app` and `email-poller` containers themselves connect to Postgres over the Docker-internal network at `db:5432` (hardcoded in `docker-compose.yml`) regardless of `DB_PORT` — `DB_PORT`/`DATABASE_URL` only matter for host-side tooling and direct DB access.

   **Auth**
   - `AUTH_SECRET` — generate with `npx auth secret` or `openssl rand -base64 32`. Required; do not leave blank.
   - `AUTH_URL` — the public URL this deployment will be reachable at (e.g. `https://psa.yourmsp.internal`). Defaults to `http://localhost:3000` in Compose if unset, which is only correct for local testing.
   - `AUTH_TRUST_HOST` — leave `true` unless you have a specific reason to change it; required for Auth.js to trust the host header behind most reverse-proxy setups.

   **Microsoft Graph API (email-to-ticket poller)** — required only if the `email-poller` service will be used:
   - `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` — from an Azure AD app registration with `Mail.Read` (or `Mail.ReadWrite`) **application** permission, with admin consent granted.
   - `MAILBOX_ADDRESS` — the shared mailbox the poller reads from.

   **QuickBooks Online integration** — required only if QBO push will be used:
   - `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` — from an Intuit developer app registration.
   - `QBO_ENVIRONMENT` — `sandbox` or `production`.
   - `QBO_REDIRECT_URI` — must exactly match the redirect URI registered in the Intuit developer app (e.g. `https://psa.yourmsp.internal/api/qbo/callback`).

   **Token encryption key (new in Phase 6, required before QuickBooks works)**
   - `TOKEN_ENCRYPTION_KEY` — a 32-byte AES-256-GCM key, base64-encoded, used by `src/lib/crypto.ts` to encrypt `QuickBooksConnection.accessToken`/`refreshToken` at rest before they are written to the database. Generate it with:

     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
     ```

     This variable is **required** — `getValidQboClient()` throws a clear, actionable error if it is missing or not exactly 32 bytes when decoded. If you rotate or lose this key, any existing stored QuickBooks connection becomes undecryptable (by design — decryption failures are logged distinguishably and the connection is treated as invalid rather than silently corrupting data) and must be re-established via `/admin/quickbooks` after the new key is in place. **Back this key up separately from the database** — losing it means losing the ability to decrypt stored QBO tokens even if the database itself is intact.

---

## Build and start

From the repository root, with `.env` fully populated:

```bash
docker compose build
docker compose up -d
```

Confirm all three services are running:

```bash
docker compose ps
```

You should see three services: `app` (the Next.js web application, port 3000), `email-poller` (the background Microsoft Graph polling process, no published port), and `db` (Postgres 16, port `${DB_PORT:-5432}`). Check logs for any of them with `docker compose logs -f <service>` if a service does not come up healthy.

---

## Database migration

`npm run db:migrate:deploy` and `npm run test:e2e` (below) run on the **host**, not inside a container — Node.js must be installed on the host (matching the version pinned in `Dockerfile`, currently `node:20.20`), and the project's dependencies must be installed there once:

```bash
npm install
```

Skipping this step produces `sh: 1: prisma: not found` (or an equivalent "command not found" for other host-side scripts) since `node_modules/.bin` won't exist yet.

Then run the migration script against the running `db` service:

```bash
npm run db:migrate:deploy
```

This is a real `package.json` script that chains two steps:

```
prisma migrate deploy && bash scripts/post-migrate.sh
```

1. `prisma migrate deploy` applies every migration under `prisma/migrations/` in order, including this phase's `20260901190000_add_defense_in_depth_indexes` migration (adds `@@index([companyId])` to `Contact`/`Contract`/`Asset` and a unique index on `Invoice.qboInvoiceId`).
2. `scripts/post-migrate.sh` then idempotently (`CREATE UNIQUE INDEX IF NOT EXISTS`) re-applies the one-active-timer-per-user partial index on `TimeEntry`, which Prisma's schema DSL cannot express directly and which `prisma migrate deploy` alone does not guarantee on a fresh environment (see the script's own header comment for the full history). It is safe to run repeatedly.

Run this command from the host (not inside a container) with `DATABASE_URL` in your shell environment pointing at the published `db` port (i.e. matching `.env`'s `DATABASE_URL`/`DB_PORT`), or `exec` into the `app` container and run it there against the Docker-internal `db:5432` address. Either way, run it once after `docker compose up -d` and again after pulling any future update that adds new migrations.

> **Warning — this phase's migration can fail on a non-empty database.** `20260901190000_add_defense_in_depth_indexes` adds a unique constraint on `Invoice.qboInvoiceId`. Multiple `NULL` values are fine (most invoices haven't been pushed to QBO yet), but if the target database already has two or more `Invoice` rows sharing the same non-null `qboInvoiceId`, Postgres will reject the migration with `duplicate key value violates unique constraint`. This matters any time you're migrating a database that isn't brand-new — upgrading an existing pre-Phase-6 deployment, or re-running against a used staging DB. Before running `npm run db:migrate:deploy` against such a database, check for duplicates first:
>
> ```sql
> SELECT "qboInvoiceId", COUNT(*) FROM "Invoice" WHERE "qboInvoiceId" IS NOT NULL GROUP BY "qboInvoiceId" HAVING COUNT(*) > 1;
> ```
>
> If this returns any rows, the migration will fail until those duplicates are resolved — that's a data decision for the operator/admin (which row is authoritative), not something to fix blindly in code.

---

## First-run verification

**Do not rely on the seeded demo users for a real deployment.** `prisma/seed.ts` creates five test accounts (`technician@mspdemo.local`, `dispatcher@mspdemo.local`, `sales@mspdemo.local`, `finance@mspdemo.local`, `admin@mspdemo.local`), all sharing a single well-known password (`Password123!`). The seed script itself refuses to run when `NODE_ENV=production` unless `ALLOW_SEED_IN_PRODUCTION=true` is explicitly set, precisely to prevent these well-known credentials from ever existing in a real deployment's database.

**There is currently no self-service signup flow and no admin-user-management UI in the application** — confirmed by inspecting `src/auth.ts` (a Credentials-only Auth.js provider that checks `db.user.hashedPassword` and never creates a user) and by a full-project search for any registration route or admin user-creation screen, neither of which exists. The only way any account is created is a direct write to the `User` table. In practice, for a real deployment, the operator must create the first real admin account one of these ways:

- Run `prisma/seed.ts` against the production database with a **modified** user list (replace the demo emails/password with the MSP's real admin email and a strong, unique password) and set `ALLOW_SEED_IN_PRODUCTION=true` for that one run only, or
- Write and run a small one-off script (or a `prisma studio` / direct `psql` session) that inserts a `User` row with `role: "admin"` and a bcrypt hash (matching `src/auth.ts`'s `compare()` call, which uses `bcryptjs`) of a real password.

Either approach is a manual, one-time bootstrap step for a fresh deployment. **This is a real gap, not a documentation oversight** — see "Operational notes" below for the recommendation to close it in a future phase.

Once a real admin account exists:

1. Navigate to `AUTH_URL` and log in with the real admin account (not a seeded demo account).
2. Confirm the dashboard loads and at least one core workflow is reachable (e.g. Tickets, Clients, Reports).
3. If QuickBooks will be used, go to `/admin/quickbooks` and complete the OAuth connect flow — this is also the point at which `TOKEN_ENCRYPTION_KEY` is first exercised for a real write.

---

## Running E2E verification

This phase added an automated Playwright E2E suite covering the three core workflows (ticket lifecycle, time entry to invoice, and SLA tracking). Running it against a deployment is a strong, automated confirmation that "core workflows pass end-to-end verification" beyond a manual click-through.

One-time browser binary install (only needs to be run once per host/environment that will execute the suite):

```bash
npx playwright install --with-deps chromium
```

Then run the suite:

```bash
npm run test:e2e
```

This runs `playwright test`, which (per `playwright.config.ts`) starts its own `npm run dev` server against `http://localhost:3000` and runs against whatever database that dev server is connected to. **Treat this as a pre-deployment or staging verification step, not something to run directly against a live production database** — the specs create their own throwaway companies/contracts/tickets (with unique timestamp-suffixed names) as part of each test, and while they are additive-only (no cleanup step deletes this data), running them against production would leave test data behind. Recommended usage: run `npm run test:e2e` against a staging instance (or a local clone pointed at a disposable database) before promoting a build to production, and periodically thereafter as a regression check.

Two known gaps in current E2E coverage, both intentional and documented in the specs themselves, not defects in this runbook:
- `e2e/tickets.spec.ts` has two `test.fixme` placeholders for the ownership-scoped delete behavior (see "Operational notes" below) — there is currently no delete button anywhere in the UI to drive that test through, so it cannot be exercised end-to-end yet.
- E2E test execution itself (`npx playwright test` actually passing against a live server) had not been run as part of any Phase 6 plan at the time each spec was written — each plan verified only that the spec type-checks (`npx tsc --noEmit`). Running `npm run test:e2e` for the first time against a real environment, per this section, is the first actual execution of these specs and should be treated as a verification step to perform before considering the suite "proven," not an already-confirmed-passing gate.

---

## Operational notes

- **`DB_PORT` per-environment convention**: `.env.example` documents `DB_PORT` as a value to vary per checkout/worktree so multiple instances of this stack (e.g. a staging environment running alongside production on the same host) don't collide on the same host Postgres port. For a single production deployment, the default `5432` is fine. If you stand up a second instance (staging) on the same host, give it a distinct `DB_PORT` (e.g. `5433`) and a distinct `DATABASE_URL` to match.

- **Rate-limit threshold tuning**: the thresholds (60 req/60s general, 10 req/60s on `/api/auth/*`) are hardcoded in `src/middleware.ts`, not environment-configurable. If legitimate traffic from a NAT'd office (many technicians sharing one public IP) is being throttled, or if you want the limiter tighter for an internet-exposed deployment, this requires editing the constants in `src/middleware.ts` and rebuilding the `app` image (`docker compose build app && docker compose up -d app`) — there is no runtime env var for this today.

- **Ownership-scoped ticket delete has no UI entry point**: Phase 6 added an ownership check to `deleteTicket` (a `technician` may only delete a ticket assigned to them; `dispatcher`/`admin` are unrestricted) at the Server Action level, but no delete button, menu, or affordance exists anywhere in the UI to invoke it — confirmed by a full-project search finding zero references to `deleteTicket` outside its own definition. This is not a deployment blocker (the function is simply unreachable, not broken), but operators should be aware that "ticket deletion" is not currently an available feature through the UI at all, for any role, despite the underlying authorization logic being in place.

- **No admin/signup UI to create real user accounts**: as covered in "First-run verification" above, creating any account today requires a direct database write (via a modified seed script run or a manual insert). If this application will be operated long-term, prioritize adding a real admin user-management screen in a future phase — this is a genuine operational gap in the current build, not just a missing convenience.

- **QuickBooks Item-mapping caveat**: `src/lib/actions/invoices.ts` (around line 352-367, `SalesItemLineDetail`) hardcodes `ItemRef.value` to `"1"` for every invoice line pushed to QuickBooks Online. QBO requires each line to reference a real `Item` entity configured in the target QBO company (commonly the default "Services" item, which is often ID `1`, but this is **not guaranteed** across every QBO company/chart-of-accounts configuration). This codebase has no Item-mapping concept — it does not look up or let the operator configure which QBO Item ID each invoice line should reference. **Before relying on QBO push in production, confirm that ID `1` actually resolves to a valid, appropriate Item in your specific QBO company** (check via QBO's own UI or API), or invoice pushes will fail or post against the wrong item. This is a known, accepted limitation carried into Phase 6, not something this phase's scope included fixing.

- **Rebuilding after code changes**: any future code change requires `docker compose build` followed by `docker compose up -d` to pick it up (Compose will recreate only the containers whose image changed). Database migrations added after this document's writing should be applied with `npm run db:migrate:deploy` per the "Database migration" section above, every time new migrations are pulled.
