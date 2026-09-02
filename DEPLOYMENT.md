# Deployment Guide

This document describes how to deploy the MSP PSA application on the MSP's own self-hosted infrastructure using Docker Compose. It reflects the application's state as of the end of Phase 7 (Account Management & Session Freshness) and is written to be followed top to bottom on a fresh host.

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
npx prisma generate
```

Skipping `npm install` produces `sh: 1: prisma: not found` (or an equivalent "command not found" for other host-side scripts) since `node_modules/.bin` won't exist yet. Skipping `npx prisma generate` produces `Error: Cannot find module '.prisma/client/default'` the first time any script imports `@prisma/client` (e.g. `prisma db seed`) — `npm install` alone does not generate the Prisma client on this project; only the Docker build's explicit `RUN npx prisma generate` step does that automatically, so host-side tooling needs the same command run manually once.

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

> **Warning — on an upgrade, this must complete before the `app` container restarts.** Application code that runs ahead of its schema does not fail partially here: `authorize()` selects every column, an absent column raises Prisma **P2022** on every request, and the login form reports "Invalid email or password" to everyone including every admin. See "Order matters: apply the migration *before* the app restarts" in the next section for the full explanation and the safe upgrade order.

Run this command from the host (not inside a container) with `DATABASE_URL` in your shell environment pointing at the published `db` port (i.e. matching `.env`'s `DATABASE_URL`/`DB_PORT`), or `exec` into the `app` container and run it there against the Docker-internal `db:5432` address. Either way, run it once after `docker compose up -d` and again after pulling any future update that adds new migrations.

> **Warning — this phase's migration can fail on a non-empty database.** `20260901190000_add_defense_in_depth_indexes` adds a unique constraint on `Invoice.qboInvoiceId`. Multiple `NULL` values are fine (most invoices haven't been pushed to QBO yet), but if the target database already has two or more `Invoice` rows sharing the same non-null `qboInvoiceId`, Postgres will reject the migration with `duplicate key value violates unique constraint`. This matters any time you're migrating a database that isn't brand-new — upgrading an existing pre-Phase-6 deployment, or re-running against a used staging DB. Before running `npm run db:migrate:deploy` against such a database, check for duplicates first:
>
> ```sql
> SELECT "qboInvoiceId", COUNT(*) FROM "Invoice" WHERE "qboInvoiceId" IS NOT NULL GROUP BY "qboInvoiceId" HAVING COUNT(*) > 1;
> ```
>
> If this returns any rows, the migration will fail until those duplicates are resolved — that's a data decision for the operator/admin (which row is authoritative), not something to fix blindly in code.

---

## Creating the first admin account and onboarding the team

<!-- Phase 8: revisit for Caddy/TLS topology -->

> ### Precondition — do not onboard anyone until this deployment is behind TLS
>
> `docker-compose.yml` publishes the app directly (`"3000:3000"`) with **no reverse proxy in front of it**, so every byte this application exchanges today crosses the network as plaintext HTTP: the admin password typed at the login form, every temporary password an admin reads off `/admin/users` and hands to a technician, and every session cookie that authenticates all subsequent requests. Anything with visibility of that path — another host on the office LAN, a span port, a compromised access point — can read a session cookie and replay it as that user, and no password rotation revokes an already-stolen 8-hour token.
>
> **Phase 8 delivers a Caddy reverse proxy that terminates TLS. Until it has landed and `AUTH_URL` is an `https://` URL, do not create accounts for the team.** Bootstrapping one admin and clicking through the app over a loopback (`http://localhost:3000` on the host itself) or a trusted segment, to prove the deployment works, is fine. Distributing credentials to staff is not — those are the passwords people reuse and the sessions that carry every ticket, invoice and QuickBooks action in this system.

### Order matters: apply the migration *before* the app restarts

**Run `npm run db:migrate:deploy` (see "Database migration" above) and confirm it succeeded before starting or restarting the `app` and `email-poller` containers on any upgrade that includes new columns.** This is not a preference — with application code running ahead of its schema, this app does not degrade partially, it fails completely and misleadingly:

- `authorize()` (`src/auth.ts`) looks the user up with `findUnique` and **no `select` clause**, so Prisma asks Postgres for every column the current schema defines.
- If a column the code knows about does not yet exist in the database, Prisma raises **P2022** (`The column ... does not exist in the current database`) on that query — and therefore on *every* login attempt and every authenticated page load.
- `loginAction` translates any failure from `authorize()` into the same anti-enumeration message the wrong password produces: **"Invalid email or password"**. Every user sees it. **Including every admin.** There is no in-app escape hatch, no error detail, and nothing in the UI that says "run a migration": recovering requires shell access to the host and `docker compose logs app` (or `psql`) to see the real P2022 underneath.

So the safe upgrade order on an existing deployment is: pull → `npm install && npx prisma generate` → **`npm run db:migrate:deploy`** → `docker compose build` → `docker compose up -d`. On a brand-new deployment, `docker compose up -d` before the migration is harmless *provided nobody tries to log in* until `db:migrate:deploy` has run.

`scripts/create-admin.ts` (below) detects P2022 itself and prints this same guidance rather than a raw Prisma stack trace, so if you bootstrap the admin before restarting anything, the script tells you the migration is missing.

### Create the admin: `npm run bootstrap:admin`

```bash
set -a; . ./.env; set +a     # the script does not load .env by itself
npm run bootstrap:admin
```

This runs `scripts/create-admin.ts` on the **host** (same host-side tooling requirements as `npm run db:migrate:deploy`: `npm install` and `npx prisma generate` must already have been run). It prompts for a display name, an email address and a password, then creates the account with `role: "admin"` and reads the row straight back out of the database so you can see the role you actually got:

```
Created admin account (read back from the database):

  id                 cmt...
  email              admin@yourmsp.com
  role               admin
  isActive           true
  mustChangePassword false
```

Details that matter:

- **The password is never accepted as an argument or an environment variable.** It is read from an interactive prompt with terminal echo suppressed, and is never printed or logged. `npm run bootstrap:admin -- admin@yourmsp.com hunter2` is rejected: a password passed that way lands in your shell history and is visible in `ps` output to every other user on the host for as long as the process runs. The email may come from the command line (`npm run bootstrap:admin -- admin@yourmsp.com`); the password may not.
- **The script requires an interactive terminal.** It refuses to run from a pipe, a CI job, or `docker compose exec` without `-it`, rather than silently accepting an empty password.
- **Minimum password length is 12 characters**, imported from the same constant the rest of the application uses (`src/lib/validations/user.ts`), with no composition rules. You are asked to type it twice, since you cannot see it.
- **The email is lowercased** before it is stored. `authorize()` looks accounts up with `email.toLowerCase()`, so an address stored with any uppercase character would be permanently unreachable — and the failed login would report "Invalid email or password" with no hint as to why.
- **`DATABASE_URL` must be exported into your shell.** Unlike `prisma db seed`, a plain `tsx` script on this project loads no `.env` file; the script checks the variable up front and tells you so by name instead of failing inside the Postgres driver with an undefined-connection-string error.
- **An existing email is refused, not overwritten** — non-zero exit, nothing written, and a pointer to the `--reset-password` path below.

The demo-account seed is **no longer the documented way to create a real admin.** `prisma/seed.ts` and its `ALLOW_SEED_IN_PRODUCTION` override still exist and the guard rail is still correct, but it is now a local-development tool only — see "First-run verification" below.

### Onboard the rest of the team

1. Navigate to `AUTH_URL` and log in as the admin you just created.
2. Go to **Admin → Users** (`/admin/users`), which is admin-only and gated at both the route and the Server Action layer.
3. Create an account for each staff member with the appropriate role (`technician`, `dispatcher`, `sales`, `finance`, `admin`). The application generates a strong temporary password and **displays it exactly once** — it is never emailed, never logged, and cannot be retrieved again. Copy it before dismissing the dialog and deliver it to that person over a channel you trust (in person, or a password manager's share link — not a plaintext email or a group chat).
4. Every account created this way is flagged `mustChangePassword`, so that person's first login lands on `/change-password` and nothing else in the app is reachable until they set their own password. That is enforced server-side, not just in the UI — a temporary password that leaked in transit cannot be used to call an action.
5. If you lose or mistype a temporary password before it reaches its owner, reset it from the same screen; a new one is generated and the old one stops working immediately.

### If you are locked out: `--reset-password` (break-glass)

There is no self-service "forgot password" flow in this build, and resetting another user's password from `/admin/users` requires an admin session — so if the only admin loses their password, there is nothing in the UI that can recover it. That is what this flag is for:

```bash
set -a; . ./.env; set +a
npm run bootstrap:admin -- --reset-password admin@yourmsp.com
```

It is deliberately loud and never the default. It prints the target account's id, email, name, role and active state, and requires you to **type that account's email back** before anything is written; anything else aborts with a non-zero exit and no change. It then prompts for a new password (hidden, twice, same 12-character floor) and clears `mustChangePassword`, so a recovered admin lands on the dashboard rather than being bounced into `/change-password` mid-outage.

It only targets accounts whose role is already `admin` — a normal user's password is reset by an admin from `/admin/users`. It also does **not** reactivate a deactivated account: if the target has `isActive = false` it warns you that resetting the password changes nothing (an inactive account is rejected before its password is ever compared) and that reactivation is a separate, deliberate decision made from `/admin/users`.

Treat host shell access as equivalent to admin access to this application, because this flag makes it so.

### Deactivation is silent by design — tell people out of band

When you deactivate a user from `/admin/users`, their existing session stops working on their next request (the session is re-checked against the database on every request, not carried for the life of the 8-hour token), and any attempt to log in again returns **"Invalid email or password"** — the exact message a wrong password or a nonexistent account produces.

**This is deliberate**, not a missing feature: `authorize()` returns an identical failure for "no such account", "deactivated", "no password set" and "wrong password", and checks `isActive` *before* comparing the password so the two cannot even be told apart by response timing. That is what stops an outsider using the login form to discover which email addresses have accounts here.

The operational consequence is that **a deactivated person is never told they were deactivated** — they see the same screen someone who forgot their password sees, and their natural next step is to file a support request. Offboarding must therefore be communicated out of band (by the manager, in the offboarding checklist). Note also that deactivation is not deletion: the row stays, and their tickets, comments and time entries remain intact for billing history, so a mistaken deactivation is reversible with **Reactivate** on the same screen.

---

## First-run verification

**Do not rely on the seeded demo users for a real deployment.** `prisma/seed.ts` creates five test accounts (`technician@mspdemo.local`, `dispatcher@mspdemo.local`, `sales@mspdemo.local`, `finance@mspdemo.local`, `admin@mspdemo.local`), all sharing a single well-known password (`Password123!`). It exists for local development and for the E2E suite's login fixture. The seed script refuses to run when `NODE_ENV=production` unless `ALLOW_SEED_IN_PRODUCTION=true` is explicitly set, precisely to prevent these well-known credentials from ever existing in a real deployment's database — **do not set that override on a production database.** Creating the real admin is `npm run bootstrap:admin`'s job, as described above; the previous guidance in this document (a modified seed run, or a hand-written `psql` insert) is obsolete and should not be followed.

Once the real admin account exists (see the previous section):

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

- **Account management exists; self-service signup does not**: this gap is closed for the operator's purposes. `npm run bootstrap:admin` creates the first admin (no seed run, no hand-written insert), and `/admin/users` handles create / change-role / reset-password / deactivate / reactivate for everyone after that — see "Creating the first admin account and onboarding the team" above. What still does not exist, deliberately: **self-service signup** (accounts are only ever created by an admin), **self-service password reset** (a locked-out user needs an admin; a locked-out *sole admin* needs host shell access and `npm run bootstrap:admin -- --reset-password`), **email invitations** (temporary passwords are shown once on screen and delivered by the admin out of band), and **an audit log** — any admin may reset, demote or deactivate any other admin, and the only trace is an unstructured line in the `app` container's stdout. Plan for admin accounts accordingly: they are mutually trusting, and `docker compose logs app` is not a tamper-evident record.

- **QuickBooks Item-mapping caveat**: `src/lib/actions/invoices.ts` (around line 352-367, `SalesItemLineDetail`) hardcodes `ItemRef.value` to `"1"` for every invoice line pushed to QuickBooks Online. QBO requires each line to reference a real `Item` entity configured in the target QBO company (commonly the default "Services" item, which is often ID `1`, but this is **not guaranteed** across every QBO company/chart-of-accounts configuration). This codebase has no Item-mapping concept — it does not look up or let the operator configure which QBO Item ID each invoice line should reference. **Before relying on QBO push in production, confirm that ID `1` actually resolves to a valid, appropriate Item in your specific QBO company** (check via QBO's own UI or API), or invoice pushes will fail or post against the wrong item. This is a known, accepted limitation carried into Phase 6, not something this phase's scope included fixing.

- **Rebuilding after code changes**: any future code change requires `docker compose build` followed by `docker compose up -d` to pick it up (Compose will recreate only the containers whose image changed). Database migrations added after this document's writing should be applied with `npm run db:migrate:deploy` per the "Database migration" section above, every time new migrations are pulled.
