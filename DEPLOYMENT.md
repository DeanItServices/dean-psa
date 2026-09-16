# Deployment Guide

This document describes how to deploy the MSP PSA application on the MSP's own self-hosted infrastructure using Docker Compose. It reflects the application's state as of the end of Phase 8 (Deployment Hardening) and is written to be followed top to bottom on a fresh host.

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
- **A public DNS name pointing at this host.** Caddy obtains a real TLS certificate for it via the ACME HTTP-01 challenge; there is no self-signed fallback and no manual certificate path in this repository.
- Outbound network access from the host to:
  - Let's Encrypt's ACME endpoints (`acme-v02.api.letsencrypt.org`) — required for certificate issuance and renewal. Without it Caddy starts, serves nothing over TLS, and retries in the background.
  - Microsoft Graph API (`login.microsoftonline.com`, `graph.microsoft.com`) if the email-to-ticket poller will be used.
  - Intuit's QuickBooks Online API (`sandbox-quickbooks.api.intuit.com` or `quickbooks.api.intuit.com`, and `appcenter.intuit.com` for the OAuth flow) if QuickBooks integration will be used.

### Network / firewall considerations

As of Phase 8 the only internet-facing service is Caddy. `docker-compose.yml` publishes:

| Service | Published ports | Reachable from |
|---------|-----------------|----------------|
| `caddy` | `${HTTP_PORT:-80}:80`, `${HTTPS_PORT:-443}:443` | the public internet — this is the intended ingress |
| `app` | **none** | the internal Compose network only, at `app:3000` |
| `email-poller` | **none** | nothing (outbound-only polling process) |
| `db` | `127.0.0.1:${DB_PORT:-5432}:5432` | **this host only** — loopback-scoped, not the LAN, not the internet |

Three consequences worth stating explicitly:

- **`app` is no longer directly reachable.** Publishing `3000` again would let a client reach the application without passing through Caddy — and forge `X-Forwarded-For` on the way in. Do not re-add that mapping.
- **Inbound TCP :80 must be open to the internet**, not only :443. Caddy answers the ACME HTTP-01 challenge on port 80 and redirects `http://` to `https://` itself. Blocking :80 does not "force HTTPS"; it prevents certificate issuance entirely, and the site then serves no TLS at all.
- **Postgres is reachable from this host only.** The loopback bind keeps host-side tooling (`npm run db:migrate:deploy`, `npm run db:seed`, `npm run bootstrap:admin`, the E2E suite) working without exposing the database to the network. A Postgres client on another machine cannot connect; tunnel over SSH if you need one.

**Rate limiting — what it does and does not give you.** `src/proxy.ts` applies an in-memory, IP-keyed fixed-window rate limiter: by default 60 requests/60s per IP for general routes, and a tighter 10 requests/60s per IP for the credential-check surface (`/api/auth/*` and `POST /login`).

- **It now keys on a trustworthy value.** `X-Forwarded-For` and `X-Real-IP` are ordinary client-settable headers, so before Phase 8 — with `app` published directly and nothing in front of it — a client could send a fresh forged IP on every request and bypass the limiter entirely, brute-force protection included. The `Caddyfile` closes that: `header_up X-Forwarded-For {remote_host}` replaces the header with Caddy's own observation of the peer address, which is the entry the limiter reads. That holds unconditionally, not just under Caddy's default behaviour — see the trust-boundary comment on `getClientIp()` in `src/proxy.ts` for the full reasoning and the two remaining ways to lose it (re-publishing `app`'s port, and a Docker daemon that does not preserve source addresses).
- **Do not delete the `header_up` line on Caddy's advice.** `caddy validate` emits `Unnecessary header_up X-Forwarded-For: the reverse proxy's default behavior is to pass headers to the upstream` — a lint heuristic that is wrong here. Verified live on `caddy:alpine` v2.11.4 by forging `X-Forwarded-For: 66.66.66.66, 7.7.7.7` through three configurations: bare `reverse_proxy` dropped it (upstream saw the peer), `reverse_proxy` plus `trusted_proxies 0.0.0.0/0` forwarded it **attacker-value-first** (`66.66.66.66, 7.7.7.7, <peer>`), and the shipped `Caddyfile` dropped it in both cases. The directive is what makes the guarantee independent of `trusted_proxies` and of whichever Caddy version the floating `:alpine` tag resolves to.
- **After go-live, confirm Caddy sees real client addresses.** `docker compose logs caddy` should show varied `remote_ip` values. If every entry is the same bridge-gateway address, the Docker daemon is routing published ports through the userland `docker-proxy` rather than iptables DNAT, and the limiter is bucketing the entire internet together — which does not weaken it so much as turn it into a lockout for staff and attacker alike.
- **It is still a speed bump, not a production-grade or distributed limiter.** The counter is per-process and in-memory: it resets on container restart, and a second `app` replica would track its own independent counters, effectively multiplying the real limit by the replica count. For a defense-in-depth layer in front of it, Caddy's own `rate_limit` module or an upstream WAF is the place to add one.
- **The thresholds are operator-tunable at runtime.** `RATE_LIMIT_WINDOW_MS` (default `60000`), `RATE_LIMIT_GENERAL` (default `60`) and `RATE_LIMIT_AUTH` (default `10`) are read from the environment when the `app` process starts. All three are optional; leave them unset to keep the defaults. See "Rate-limit threshold tuning" under "Operational notes" for the procedure — it needs a restart, not a rebuild.

---

## First-time setup

1. **Clone the repository** onto the target host and `cd` into it.

2. **Copy the environment template**:

   ```bash
   cp .env.example .env
   ```

3. **Fill in every variable in `.env`**, group by group:

   **Database connection**
   - `POSTGRES_PASSWORD` — **required, no default.** The password for the `postgres` role, used in three places by `docker-compose.yml` (the `db` service's `POSTGRES_PASSWORD` and both containers' `DATABASE_URL`). Compose fails fast with `required variable POSTGRES_PASSWORD is missing` rather than starting on a guessable credential. Generate it URL-safely:

     ```bash
     openssl rand -hex 32
     ```

     Use hex, **not** `openssl rand -base64 32`. This value is embedded in the `DATABASE_URL` *URI*, where `+ / = @ : ? #` break parsing — and the failure is asymmetric and maximally confusing, because `db` starts up perfectly healthy (it treats the password as an opaque literal) while only `app` fails to connect.

     **This applies at initdb only.** On a host where the `pgdata` volume already exists, changing this value in `.env` does nothing to the database and the app simply stops connecting — see "Rotating the database password" below for the procedure that actually works.
   - `DB_PORT` — the host port Postgres is published on, **bound to `127.0.0.1`**. Default `5432` is fine for a single production instance. Change it if you are running multiple instances of this stack (e.g. staging alongside production, or several git worktrees) on the same host — see "Operational notes" below.
   - `DATABASE_URL` — the **host-side** connection string, used by tooling run outside Docker (`npm run db:migrate:deploy`, `npm run db:seed`, `npm run bootstrap:admin`, the E2E suite). It must match `POSTGRES_PASSWORD` and `DB_PORT`. The `app` and `email-poller` containers do **not** read it — Compose builds their own `DATABASE_URL` pointing at `db:5432` on the internal network.

     `.env.example` writes this as `postgresql://postgres:${POSTGRES_PASSWORD}@localhost:${DB_PORT}/msp_psa?schema=public`. **Docker Compose expands that; plain dotenv does not.** `prisma7.config.ts` loads `.env` via `import "dotenv/config"`, which hands Prisma the literal string `${POSTGRES_PASSWORD}` and fails with a connection error. Either source `.env` into your shell before running host-side scripts (`set -a; . ./.env; set +a`, as every host-side command in this document does) or paste the literal password into the line instead of the `${...}` reference.

   **Public site address and TLS**
   - `SITE_ADDRESS` — **required, no default.** The public hostname Caddy serves and obtains a certificate for, e.g. `psa.yourmsp.com`. Hostname only: no scheme, no path, no port. Public DNS for this name must already resolve to this host, and inbound :80 must be reachable, before the first request can get a certificate.
   - `HTTP_PORT` / `HTTPS_PORT` — optional, defaulting to `80`/`443`. Only change them to run a second stack side by side on the same host; HTTP-01 issuance needs the real public :80.

   **Auth**
   - `AUTH_SECRET` — generate with `npx auth secret` or `openssl rand -base64 32`. Required; do not leave blank.
   - `AUTH_URL` — **required, no default.** The public `https://` URL this deployment is reachable at, matching `SITE_ADDRESS` (e.g. `https://psa.yourmsp.com`). Compose fails fast if it is unset. It must be `https://`: Auth.js decides whether to use the `__Secure-` cookie prefix from this URL's protocol alone, so an `http://` value behind TLS silently issues a non-Secure session cookie with no error anywhere. That is the single condition the onboarding guidance below depends on.
   - `AUTH_TRUST_HOST` — leave `true` unless you have a specific reason to change it; required for Auth.js to trust the host header behind a reverse proxy, which this deployment now always has.

   **Rate limiting** — all optional; leave unset to keep the defaults:
   - `RATE_LIMIT_WINDOW_MS` (default `60000`), `RATE_LIMIT_GENERAL` (default `60`), `RATE_LIMIT_AUTH` (default `10`). Read by `src/proxy.ts` when the `app` process starts. A value that is not a positive integer — including `0` — is rejected with a warning in `docker compose logs app` and the default is used instead: a typo cannot disable rate limiting.

   **Microsoft Graph API (email-to-ticket poller)** — required only if the `email-poller` service will be used:
   - `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` — from an Azure AD app registration with `Mail.Read` (or `Mail.ReadWrite`) **application** permission, with admin consent granted.
   - `MAILBOX_ADDRESS` — the shared mailbox the poller reads from.

   **QuickBooks Online integration** — required only if QBO push will be used:
   - `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` — from an Intuit developer app registration.
   - `QBO_ENVIRONMENT` — `sandbox` or `production`.
   - `QBO_REDIRECT_URI` — must exactly match the redirect URI registered in the Intuit developer app, and must now be `https://` (e.g. `https://psa.yourmsp.com/api/qbo/callback`).

     **Setting it here is only half the job.** The same `https://` URI must ALSO be updated in the Intuit developer app registration at <https://developer.intuit.com>. Nothing in this repository can do that for you, and nothing here can detect that it was missed: Intuit rejects any callback whose URI does not match the registered one, with an opaque error on Intuit's own page. If you are upgrading an existing deployment whose registered URI is `http://`, change it at Intuit **before** anyone tries to connect QuickBooks.

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

Confirm all four services are running:

```bash
docker compose ps
```

You should see four services: `caddy` (the TLS-terminating reverse proxy, ports `${HTTP_PORT:-80}` and `${HTTPS_PORT:-443}`), `app` (the Next.js web application, **no published port** — reachable only as `app:3000` on the internal network), `email-poller` (the background Microsoft Graph polling process, no published port), and `db` (Postgres 16, `127.0.0.1:${DB_PORT:-5432}`). Check logs for any of them with `docker compose logs -f <service>` if a service does not come up healthy.

If `docker compose up -d` refuses to start with `required variable ... is missing`, that is deliberate: `POSTGRES_PASSWORD`, `SITE_ADDRESS` and `AUTH_URL` have no defaults, because every default this project could have picked for them is a security downgrade.

### TLS: what happens on the first request

Caddy does **not** obtain a certificate at startup. It obtains one via the ACME HTTP-01 challenge on the first request for `SITE_ADDRESS`, which means both of these must already be true:

1. Public DNS for `SITE_ADDRESS` resolves to this host, and
2. inbound TCP :80 is reachable from the public internet — HTTP-01 is answered on port 80.

Make that first request yourself and watch it happen:

```bash
curl -I http://<SITE_ADDRESS>/      # expect a 308 redirect to https://
docker compose logs -f caddy        # watch issuance; look for "certificate obtained successfully"
```

If issuance fails, Caddy keeps retrying in the background and the site serves no TLS in the meantime. The usual causes are DNS not yet propagated, :80 blocked at a firewall or router, or something else on the host already bound to :80. Note that certificates and the ACME account key live in the `caddy_data` volume — deleting it forces re-issuance, which can hit Let's Encrypt's rate limits, so do not prune it casually.

No `restart:` policy is set on any service in `docker-compose.yml`. A container that exits stays down, and nothing comes back after a host reboot until someone runs `docker compose up -d`. If this deployment is meant to survive reboots unattended, add `restart: unless-stopped` to each service (or manage the stack with a systemd unit) — that is a deliberate operator decision, not something this repository assumes for you.

---

## Database migration

`npm run db:migrate:deploy` and `npm run test:e2e` (below) run on the **host**, not inside a container — Node.js must be installed on the host (matching the version pinned in `Dockerfile`, currently `node:20.20`), and the project's dependencies must be installed there once:

```bash
npm install
npx prisma generate
```

Skipping `npm install` produces `sh: 1: prisma: not found` (or an equivalent "command not found" for other host-side scripts) since `node_modules/.bin` won't exist yet. Skipping `npx prisma generate` produces `Error: Cannot find module '.prisma/client/default'` the first time any script imports `@prisma/client` (e.g. `prisma db seed`) — `npm install` alone does not generate the Prisma client on this project; only the Docker build's explicit `RUN npx prisma generate` step does that automatically, so host-side tooling needs the same command run manually once.

Then run the migration script against the running `db` service. **Source `.env` into your shell first** — this is a prerequisite, not a convenience:

```bash
set -a; . ./.env; set +a
npm run db:migrate:deploy
```

`prisma7.config.ts` loads `.env` through `import "dotenv/config"`, and **dotenv does not expand `${...}` references**. `.env.example` ships `DATABASE_URL` as `postgresql://postgres:${POSTGRES_PASSWORD}@localhost:${DB_PORT}/...`, so an operator who copies the template and runs this command without sourcing first hands Prisma the literal string `${POSTGRES_PASSWORD}` and gets a connection error that names nothing useful. `set -a; . ./.env; set +a` expands it in the shell, and because dotenv does not override a variable that is already exported, Prisma then sees the correct value. (Docker Compose expands it too, which is why the containers are unaffected — this is a host-side-tooling trap only.)

This is a real `package.json` script that chains two steps:

```
prisma migrate deploy && bash scripts/post-migrate.sh
```

1. `prisma migrate deploy` applies every migration under `prisma/migrations/` in order, including this phase's `20260901190000_add_defense_in_depth_indexes` migration (adds `@@index([companyId])` to `Contact`/`Contract`/`Asset` and a unique index on `Invoice.qboInvoiceId`).
2. `scripts/post-migrate.sh` then idempotently (`CREATE UNIQUE INDEX IF NOT EXISTS`) re-applies the one-active-timer-per-user partial index on `TimeEntry`, which Prisma's schema DSL cannot express directly and which `prisma migrate deploy` alone does not guarantee on a fresh environment (see the script's own header comment for the full history). It is safe to run repeatedly.

> **Warning — on an upgrade, this must complete before the `app` container restarts.** Application code that runs ahead of its schema does not fail partially here: `authorize()` selects every column, an absent column raises Prisma **P2022** on every request, and the login form reports "Invalid email or password" to everyone including every admin. See "Order matters: apply the migration *before* the app restarts" in the next section for the full explanation and the safe upgrade order.

Run this command **from the host**, not inside a container, with `DATABASE_URL` exported into your shell and pointing at the published `db` port (i.e. matching `.env`'s `DATABASE_URL`/`DB_PORT`). Run it once after `docker compose up -d`, and again after pulling any future update that adds new migrations.

This works because the `db` service publishes `127.0.0.1:${DB_PORT:-5432}:5432` — Postgres is reachable **from this host only**, which is exactly what host-side tooling needs and nothing more. It is not reachable from the LAN or the internet; if you need a Postgres client on another machine, tunnel over SSH.

> **`docker compose exec app npm run db:migrate:deploy` is not a working alternative.** Earlier revisions of this document offered it; it has never worked on this image and it is not a fallback to reach for. The runner is `node:20.20-alpine`, which has neither `bash` nor `psql`, and `npm run db:migrate:deploy` chains `bash scripts/post-migrate.sh`, which needs both. `prisma migrate deploy` alone would run inside the container, but skipping `post-migrate.sh` silently omits the one-active-timer-per-user partial index — so that is not a shortcut either. Run migrations from the host.

> **Warning — this phase's migration can fail on a non-empty database.** `20260901190000_add_defense_in_depth_indexes` adds a unique constraint on `Invoice.qboInvoiceId`. Multiple `NULL` values are fine (most invoices haven't been pushed to QBO yet), but if the target database already has two or more `Invoice` rows sharing the same non-null `qboInvoiceId`, Postgres will reject the migration with `duplicate key value violates unique constraint`. This matters any time you're migrating a database that isn't brand-new — upgrading an existing pre-Phase-6 deployment, or re-running against a used staging DB. Before running `npm run db:migrate:deploy` against such a database, check for duplicates first:
>
> ```sql
> SELECT "qboInvoiceId", COUNT(*) FROM "Invoice" WHERE "qboInvoiceId" IS NOT NULL GROUP BY "qboInvoiceId" HAVING COUNT(*) > 1;
> ```
>
> If this returns any rows, the migration will fail until those duplicates are resolved — that's a data decision for the operator/admin (which row is authoritative), not something to fix blindly in code.

---

## Rotating the database password

`POSTGRES_PASSWORD` is applied by **initdb only** — the very first time the `pgdata` volume is created. On any deployment where that volume already exists, editing `.env` and restarting changes the credential the `app` and `email-poller` containers *present* and nothing about the credential Postgres *accepts*. The result is a stack where `db` reports healthy, `app` fails to connect, and nothing anywhere says "the password you set was ignored". This is the procedure that actually rotates it.

1. **Change it inside the running database first**, using the credential that still works:

   ```bash
   NEW_PASSWORD=$(openssl rand -hex 32)
   docker compose exec db psql -U postgres -d msp_psa \
     -c "ALTER USER postgres WITH PASSWORD '${NEW_PASSWORD}';"
   echo "$NEW_PASSWORD"
   ```

   `psql` is present in the `postgres:16-alpine` image, so this one runs fine under `exec` (unlike the migration scripts, which run on the host — see above). Generate with `openssl rand -hex 32` for the same URL-safety reason as the initial value: this password ends up inside a `DATABASE_URL` URI.

   Note that the form above puts the new password into your shell history and, briefly, into `ps` output for every user on the host. On a shared host, open an interactive session and type the statement instead, so it never becomes a command-line argument:

   ```bash
   docker compose exec -it db psql -U postgres -d msp_psa
   # then, at the psql prompt:
   #   \password postgres
   ```

   `\password` prompts twice with echo suppressed and issues the `ALTER USER` for you.

2. **Update `.env`** — set `POSTGRES_PASSWORD` to the new value, and update the password inside `DATABASE_URL` too if you pasted a literal there rather than using the `${POSTGRES_PASSWORD}` reference.

3. **Restart the services that hold a connection string**:

   ```bash
   docker compose up -d app email-poller
   ```

   `db` itself does not need restarting — `ALTER USER` took effect immediately. A rebuild is not needed either; these are environment values, not build inputs.

4. **Confirm**: `docker compose logs --tail=50 app` should show no connection errors, and the login page should load.

If you have already restarted into the broken state (new password in `.env`, old one in the volume), nothing is lost: put the **old** password back in `.env` temporarily, `docker compose up -d`, then run the `ALTER USER` above and follow the steps in order.

The alternative — deleting the `pgdata` volume so initdb runs again with the new password — **destroys every ticket, invoice, time entry and user account in the database.** It is only appropriate on a deployment that has never carried real data.

---

## Creating the first admin account and onboarding the team

> ### TLS precondition — satisfied as of Phase 8
>
> Earlier revisions of this document told operators **not** to create accounts for the team, and the reason is worth keeping visible rather than deleting: `docker-compose.yml` used to publish the app directly (`"3000:3000"`) with no reverse proxy in front of it, so every byte crossed the network as plaintext HTTP — the admin password typed at the login form, every temporary password an admin read off `/admin/users` and handed to a technician, and every session cookie authenticating all subsequent requests. Anything with visibility of that path — another host on the office LAN, a span port, a compromised access point — could read a session cookie and replay it as that user, and no password rotation revokes an already-stolen 8-hour token.
>
> **That is now closed.** Caddy terminates TLS in front of the app, `app` publishes no host port at all, and `http://` is redirected to `https://`. **Onboarding may proceed — on one condition:**
>
> - **`AUTH_URL` must be an `https://` URL.** Auth.js picks the `__Secure-` session-cookie prefix from that URL's protocol *alone*; an `http://` value behind a TLS front end yields a non-Secure cookie with no error and no warning anywhere, which puts you back in the position the paragraph above describes. `docker-compose.yml` now declares `AUTH_URL` with no default, so a stack with it unset refuses to start rather than leaving this to operator discipline — but a stack with it set to `http://...` will start happily. Check it, do not assume it.
>
> Verify before you hand out the first credential: log in once and look at the session cookie in your browser's developer tools. **`__Secure-authjs.session-token`** is correct. A bare **`authjs.session-token`** means `AUTH_URL` is not `https://` — fix that and restart `app` before onboarding anyone.
>
> **One-time session logout.** Changing `AUTH_URL` from `http://` to `https://` changes the cookie name, so every existing session becomes unreadable and everyone is logged out once. That is expected, not a defect — the same class of event as Phase 7's `tokenVersion` rollout. Nobody's account, password or data is affected; they log in again and continue.

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

`npm run test:e2e` runs the **gate** projects (`lifecycle` + `last-active-admin`). Per `playwright.config.ts` it starts its own `next dev` on port **3100** (override with `E2E_PORT`) — it will not reuse a server already listening, and a build-identity check in `e2e/global-setup.ts` aborts the run if the server answering is not built from the current source. That check exists because an earlier configuration silently graded a stale container image.

> **This suite is for a local development database only. Do not point it at staging or production.**
>
> `e2e/global-setup.ts` and `e2e/global-teardown.ts` **delete** rows matching `e2e-lifecycle-%@e2e.invalid`, and require the five `*@mspdemo.local` seed accounts to exist — a database bootstrapped with `npm run bootstrap:admin` has none of them, so teardown will fail with a message about fixture accounts that names the wrong cause. Run this against a database seeded by `npm run db:seed`, on a machine you are developing on.
>
> For a pre-promotion check against staging, exercise the flows by hand using the onboarding steps above rather than running this suite.

`npm run test:e2e:advisory` runs the three pre-Phase-7 specs separately. They are **expected to fail today** — they had never been executed against a browser until Phase 7, and ROADMAP Phase 9 owns their first real run and fixing what breaks. They are kept out of `test:e2e` deliberately: Playwright's exit code is per-process, not per-project, so including them would make the gate permanently red and destroy its signal. `npm run test:e2e:all` runs everything if you want the full picture.

Known gaps, intentional and documented in the specs themselves:
- `e2e/tickets.spec.ts` has two `test.fixme` placeholders for ownership-scoped delete — there is no delete button in the UI to drive them through. Phase 9.
- `scripts/create-admin.ts` has no automated test: it is gated on an interactive TTY, so it cannot be driven by the suite as written. Its behaviour is evidenced only by a manual transcript.

---

## Operational notes

- **`DB_PORT` per-environment convention**: still meaningful. The `db` service publishes `127.0.0.1:${DB_PORT:-5432}:5432` — loopback-scoped rather than removed, so Postgres is reachable from this host (which `db:migrate:deploy`, `db:seed`, `bootstrap:admin` and the E2E suite all need) and from nowhere else on the network. `.env.example` documents `DB_PORT` as a value to vary per checkout/worktree so multiple instances of this stack (e.g. a staging environment alongside production on the same host) don't collide on the same host Postgres port; that convention keeps working unchanged. For a single production deployment the default `5432` is fine. If you stand up a second instance, give it a distinct `DB_PORT` (e.g. `5433`) and a distinct `DATABASE_URL` to match — and distinct `HTTP_PORT`/`HTTPS_PORT`, remembering that only the stack holding the real :80 can complete an HTTP-01 challenge.

- **Rate-limit threshold tuning**: the thresholds are read from the environment when the `app` process starts, so retuning them costs a restart — **not** a rebuild, and no source edit. The three variables and their defaults:

  | Variable | Default | Applies to |
  |----------|---------|------------|
  | `RATE_LIMIT_WINDOW_MS` | `60000` | the fixed window length, in milliseconds |
  | `RATE_LIMIT_GENERAL` | `60` | requests per IP per window, general routes |
  | `RATE_LIMIT_AUTH` | `10` | requests per IP per window, `/api/auth/*` and `POST /login` |

  Set them in `.env` and restart the app container:

  ```bash
  docker compose up -d app
  ```

  Compose recreates the container with the new environment; there is no `docker compose build` step. All three are optional — leave them unset and the defaults above apply, which is the documented, silent path.

  Raise `RATE_LIMIT_GENERAL` if legitimate traffic from a NAT'd office (many technicians sharing one public IP) is being throttled; lower `RATE_LIMIT_AUTH` to tighten brute-force protection on an internet-exposed deployment. A value that is not a positive integer is **rejected**, not obeyed: `0`, a negative, a fraction, an empty string or anything non-numeric falls back to the default and logs a `[proxy]` warning naming the variable, the offending value and the default applied. Check `docker compose logs app` after changing one — a typo cannot disable rate limiting, but it can leave you thinking a change took effect when it did not.

- **Ownership-scoped ticket delete has no UI entry point**: Phase 6 added an ownership check to `deleteTicket` (a `technician` may only delete a ticket assigned to them; `dispatcher`/`admin` are unrestricted) at the Server Action level, but no delete button, menu, or affordance exists anywhere in the UI to invoke it — confirmed by a full-project search finding zero references to `deleteTicket` outside its own definition. This is not a deployment blocker (the function is simply unreachable, not broken), but operators should be aware that "ticket deletion" is not currently an available feature through the UI at all, for any role, despite the underlying authorization logic being in place.

- **Account management exists; self-service signup does not**: this gap is closed for the operator's purposes. `npm run bootstrap:admin` creates the first admin (no seed run, no hand-written insert), and `/admin/users` handles create / change-role / reset-password / deactivate / reactivate for everyone after that — see "Creating the first admin account and onboarding the team" above. What still does not exist, deliberately: **self-service signup** (accounts are only ever created by an admin), **self-service password reset** (a locked-out user needs an admin; a locked-out *sole admin* needs host shell access and `npm run bootstrap:admin -- --reset-password`), **email invitations** (temporary passwords are shown once on screen and delivered by the admin out of band), and **an audit log** — any admin may reset, demote or deactivate any other admin, and the only trace is an unstructured line in the `app` container's stdout. Plan for admin accounts accordingly: they are mutually trusting, and `docker compose logs app` is not a tamper-evident record.

- **QuickBooks Item-mapping caveat**: `src/lib/actions/invoices.ts` (around line 352-367, `SalesItemLineDetail`) hardcodes `ItemRef.value` to `"1"` for every invoice line pushed to QuickBooks Online. QBO requires each line to reference a real `Item` entity configured in the target QBO company (commonly the default "Services" item, which is often ID `1`, but this is **not guaranteed** across every QBO company/chart-of-accounts configuration). This codebase has no Item-mapping concept — it does not look up or let the operator configure which QBO Item ID each invoice line should reference. **Before relying on QBO push in production, confirm that ID `1` actually resolves to a valid, appropriate Item in your specific QBO company** (check via QBO's own UI or API), or invoice pushes will fail or post against the wrong item. This is a known, accepted limitation carried into Phase 6, not something this phase's scope included fixing.

- **Rebuilding after code changes**: any future code change requires `docker compose build` followed by `docker compose up -d` to pick it up (Compose will recreate only the containers whose image changed). Database migrations added after this document's writing should be applied with `npm run db:migrate:deploy` per the "Database migration" section above, every time new migrations are pulled.
