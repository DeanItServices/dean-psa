# Deployment Guide

This document describes how to deploy the MSP PSA application on the MSP's own self-hosted infrastructure using Docker Compose. It reflects the application's state as of the end of Phase 8 (Deployment Hardening) and is written to be followed top to bottom on a fresh host.

Every command below matches a real script in `package.json`, a real Docker Compose command, or a real file in this repository — nothing here is aspirational.

---

## Contents

**Installing, in order**
1. [Prerequisites](#prerequisites)
2. [First-time setup](#first-time-setup) — filling in `.env`
3. [Build and start](#build-and-start)
4. [Database migration](#database-migration)
5. [Creating the first admin account and onboarding the team](#creating-the-first-admin-account-and-onboarding-the-team)
6. [First-run verification](#first-run-verification)

**Day-2 operations** — you will not need these on day one, and you will need them in a hurry later
- [Upgrades: order matters — apply the migration *before* the app restarts](#upgrades-order-matters--apply-the-migration-before-the-app-restarts)
- [Rotating the database password](#rotating-the-database-password)
- [Rotating `AUTH_SECRET`](#rotating-auth_secret)
- [Stopping, restarting and backing up](#stopping-restarting-and-backing-up) — including [Backup](#backup) and restore
- [Operational notes](#operational-notes) — rate-limit tuning, log retention, known gaps

**Development only** — not part of a production deployment
- [Running E2E verification](#running-e2e-verification)

## Prerequisites

- **Docker** and **Docker Compose** (the `docker compose` plugin, v2 syntax — not the legacy standalone `docker-compose` binary) installed on the target host.
- **Node.js 20.19+** (matching this project's pinned `node:20.20` in `Dockerfile`; 22.12+ or 24+ also work) installed on the host itself — required for the host-side tooling described in "Database migration" below (`npm install`, `npm run db:migrate:deploy`, `npm run test:e2e`). This is separate from the Node.js version used *inside* the Docker images, which is pinned by `Dockerfile` and doesn't depend on the host. Prisma 7 refuses to install on an older Node with a clear `Prisma only supports Node.js versions 20.19+, 22.12+, 24.0+` error — check with `node --version` first. On a fresh Debian/Ubuntu host (a common case: the OS-default `apt` package is often too old), install a current Node.js via NodeSource:

  ```bash
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt install -y nodejs
  ```

  For other distros/OSes, use [nvm](https://github.com/nvm-sh/nvm) or the official installer from [nodejs.org](https://nodejs.org).
- **A PostgreSQL client (`psql`) on the host.** Not optional, and not covered by having Postgres in a container: `npm run db:migrate:deploy` chains `bash scripts/post-migrate.sh`, which shells out to `psql` (line 52) against the published loopback port.

  ```bash
  sudo apt install -y postgresql-client     # Debian/Ubuntu
  # Fedora/RHEL: sudo dnf install -y postgresql
  # macOS:       brew install libpq   (then add its bin/ to PATH)
  ```

  **What breaks without it is worse than a missing command.** `prisma migrate deploy` is the *first* half of that chain and it **succeeds**, so the migration output looks clean; the script then dies at `psql: command not found`, and the `TimeEntry_one_active_timer_per_user` partial index — the one thing `post-migrate.sh` exists to guarantee, because Prisma's schema DSL cannot express it — is **silently absent**. Nothing downstream announces this. Check with `psql --version` before migrating, and see "Database migration" below for how to confirm the index landed.
- Git access to clone this repository.
- **A public DNS name pointing at this host.** Caddy obtains a real TLS certificate for it via ACME (HTTP-01 on :80, or TLS-ALPN-01 on :443 — the shipped `Caddyfile` sets no `tls`/`acme` directive, so both challenges stay enabled and Caddy uses whichever succeeds). There is no self-signed fallback and no manual certificate path in this repository.

  > **Not verified in this project.** No publicly-trusted certificate was ever issued against this configuration during Phase 8. Every TLS observation recorded here or in the `Caddyfile` came from Caddy's **internal CA** answering for `localhost`, which exercises none of the ACME path. First-boot issuance is untested — watch `docker compose logs -f caddy` on the first real request rather than assuming it worked.
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
| `email-poller` | **none** | nothing (outbound-only polling process; opt-in via Compose profile `email`) |
| `db` | `127.0.0.1:${DB_PORT:-5432}:5432` | **this host only** — loopback-scoped, not the LAN, not the internet |

Three consequences worth stating explicitly:

- **`app` is no longer directly reachable.** Publishing `3000` again would let a client reach the application without passing through Caddy — and forge `X-Forwarded-For` on the way in. Do not re-add that mapping.
- **Inbound TCP :80 should be open to the internet**, not only :443. Two reasons, and it is worth being precise about which is which:
  1. **The `http://` → `https://` redirect lives on :80.** Block it and a user who types the bare hostname gets a connection failure, not a redirect. Blocking :80 does not "force HTTPS" — it just breaks the path that sends people to HTTPS.
  2. **HTTP-01 is the issuance fallback.** Because no `tls`/`acme` directive is set, TLS-ALPN-01 on :443 is *also* live, so strictly speaking a :443-only host can still get a certificate. Do not rely on that: closing :80 removes the second challenge, leaving issuance with no retry path if TLS-ALPN-01 fails.
- **Postgres is reachable from this host only.** The loopback bind keeps host-side tooling (`npm run db:migrate:deploy`, `npm run db:seed` (development only — refuses without `ALLOW_DEMO_SEED=true`), `npm run bootstrap:admin`, the E2E suite) working without exposing the database to the network. A Postgres client on another machine cannot connect; tunnel over SSH if you need one.

**Rate limiting — what it does and does not give you.** `src/proxy.ts` applies an in-memory, IP-keyed fixed-window rate limiter: by default 60 requests/60s per IP for general routes, and a tighter 10 requests/60s per IP for the credential-check surface (`/api/auth/*` and `POST /login`).

- **It now keys on a trustworthy value.** `X-Forwarded-For` and `X-Real-IP` are ordinary client-settable headers, so before Phase 8 — with `app` published directly and nothing in front of it — a client could send a fresh forged IP on every request and bypass the limiter entirely, brute-force protection included. The `Caddyfile` closes that: `header_up X-Forwarded-For {remote_host}` and `header_up X-Real-IP {remote_host}` replace **both** headers `getClientIp()` reads with Caddy's own observation of the peer address. It also strips the two remaining address-bearing headers a client can set (`header_up -Forwarded`, `header_up -X-Forwarded-Port`) — nothing reads those today, so that part is pre-emptive rather than a live fix. That holds unconditionally, not just under Caddy's default behaviour. **Four** conditions carry it, and each is a way to lose it; they are enumerated once, on `getClientIp()` in `src/proxy.ts`, and deliberately not re-listed here. Read that list before changing anything in front of this app. (An earlier revision of this bullet gave a short two-item version of it and silently dropped the `header_up` line — the one condition `caddy validate` actively invites you to delete. That is why the list lives in one place.)

  Covering `X-Real-IP` too is not redundant. `getClientIp()` reads `X-Forwarded-For` first and only falls back to `X-Real-IP`, and Caddy always sets the former — so a forged `X-Real-IP` was never reachable. But that made the guarantee depend on the *order of two statements inside application code*, where a future refactor can quietly invert it. Verified before the fix: upstream saw `XFF=[<peer>] XRI=[66.66.66.66]`. Verified after: `XFF=[<peer>] XRI=[<peer>] FWD=[] XFP=[]`.
- **Do not delete the `header_up` line on Caddy's advice.** `caddy validate` emits `Unnecessary header_up X-Forwarded-For: the reverse proxy's default behavior is to pass headers to the upstream` — a lint heuristic that is wrong here. **This warning is expected on every run and is also called out in the `Caddyfile` itself**, right above the line, since that is where someone acting on the advice is actually looking. Verified live on `caddy:alpine` v2.11.4 by forging `X-Forwarded-For: 66.66.66.66, 7.7.7.7` through three configurations: bare `reverse_proxy` dropped it (upstream saw the peer), `reverse_proxy` plus `trusted_proxies 0.0.0.0/0` forwarded it **attacker-value-first** (`66.66.66.66, 7.7.7.7, <peer>`), and the shipped `Caddyfile` dropped it in both cases. The directive is what makes the guarantee independent of `trusted_proxies` and of whichever Caddy version the floating `:alpine` tag resolves to.
- **Nothing may sit in front of Caddy.** The point above is about *bypass* — reaching `app` without passing through Caddy. This one is the opposite direction and is easy to miss: putting Cloudflare, an edge nginx, an ALB or any other proxy **in front of** this deployment breaks the guarantee just as thoroughly, because `{remote_host}` then observes *that proxy*, not the client. Every request on earth arrives as one address and lands in one rate-limit bucket — demonstrated by chaining two Caddies, where all clients collapsed into a single address. This is a lockout, not a bypass, and it looks identical to the `docker-proxy` symptom below.

  If you must front this deployment, the `header_up` lines are no longer correct: replace them with `trusted_proxies <CIDR of the fronting proxy>` so Caddy appends rather than overwrites, and revisit `getClientIp()` in `src/proxy.ts`, which takes entry **0** of `X-Forwarded-For` and would then be reading the client-supplied end of the chain. Neither change is shipped here, and this configuration assumes Caddy is the first hop.
- **After go-live, confirm Caddy sees real client addresses.** The `Caddyfile`'s `log` directive writes one JSON access-log line per request to stdout, so:

  ```bash
  docker compose logs caddy | grep -o '"remote_ip":"[^"]*"' | sort | uniq -c | sort -rn
  ```

  should show **varied** `remote_ip` values. If every entry is the same bridge-gateway address (e.g. `172.18.0.1`), the Docker daemon is routing published ports through the userland `docker-proxy` rather than iptables DNAT, and the limiter is bucketing the entire internet together — which does not weaken it so much as turn it into a lockout for staff and attacker alike. A fronting proxy (previous bullet) produces the same single-address picture from a completely different cause; rule that out first.

  If this command prints **nothing at all**, the `log` directive is missing from the `Caddyfile` — Caddy emits zero per-request logs without it, and the check silently reads as "nothing wrong". Confirm with `grep -c '^\s*log$' Caddyfile`.
- **It is still a speed bump, not a production-grade or distributed limiter.** The counter is per-process and in-memory: it resets on container restart, and a second `app` replica would track its own independent counters, effectively multiplying the real limit by the replica count. For a defense-in-depth layer in front of it, Caddy's own `rate_limit` module or an upstream WAF is the place to add one.
- **The thresholds are operator-tunable at runtime.** `RATE_LIMIT_WINDOW_MS` (default `60000`), `RATE_LIMIT_GENERAL` (default `60`) and `RATE_LIMIT_AUTH` (default `10`) are read from the environment once per `app` process. All three are optional; leave them unset to keep the defaults. See "Rate-limit threshold tuning" under "Operational notes" for the procedure — it needs a restart, not a rebuild.

---

## First-time setup

1. **Clone the repository** onto the target host and `cd` into it.

2. **Copy the environment template, and lock its permissions**:

   ```bash
   cp .env.example .env && chmod 600 .env
   ```

   **The `chmod` is not optional.** `cp` reproduces the template's mode `0644`, i.e. world-readable, and the file you are about to fill in holds `POSTGRES_PASSWORD`, `AUTH_SECRET`, `AZURE_CLIENT_SECRET`, `QBO_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` — every credential this deployment has, in plaintext, readable by any local account on the host. That is the same threat model under which `npm run bootstrap:admin` refuses to accept a password as an argument (because `ps` output is world-readable); a world-readable `.env` is the larger hole, and it persists rather than lasting for the life of a process. Confirm with `ls -l .env` — you want `-rw-------`.

3. **Fill in every variable in `.env`**, group by group:

   **Database connection**
   - `POSTGRES_PASSWORD` — **required, no default.** The password for the `postgres` role, used in three places by `docker-compose.yml` (the `db` service's `POSTGRES_PASSWORD` and both containers' `DATABASE_URL`). Compose fails fast with `required variable POSTGRES_PASSWORD is missing` rather than starting on a guessable credential. Generate it URL-safely:

     ```bash
     openssl rand -hex 32
     ```

     Use hex, **not** `openssl rand -base64 32`. This value is embedded in the `DATABASE_URL` *URI*, where `+ / = @ : ? #` break parsing — and the failure is asymmetric and maximally confusing, because `db` starts up perfectly healthy (it treats the password as an opaque literal) while only `app` fails to connect.

     **This applies at initdb only.** On a host where the `pgdata` volume already exists, changing this value in `.env` does nothing to the database and the app simply stops connecting — see "Rotating the database password" below for the procedure that actually works.
   - `DB_PORT` — the host port Postgres is published on, **bound to `127.0.0.1`**. Default `5432` is fine for a single production instance. Change it if you are running multiple instances of this stack (e.g. staging alongside production, or several git worktrees) on the same host — see "Operational notes" below.
   - `DATABASE_URL` — the **host-side** connection string, used by tooling run outside Docker (`npm run db:migrate:deploy`, `npm run db:seed` (development only — refuses without `ALLOW_DEMO_SEED=true`), `npm run bootstrap:admin`, the E2E suite). It must match `POSTGRES_PASSWORD` and `DB_PORT`. The `app` and `email-poller` containers do **not** read it — Compose builds their own `DATABASE_URL` pointing at `db:5432` on the internal network.

     `.env.example` writes this as `postgresql://postgres:${POSTGRES_PASSWORD}@localhost:${DB_PORT}/msp_psa?schema=public`. **Docker Compose expands that; plain dotenv does not, and neither does the E2E suite's own `.env` reader.** `prisma7.config.ts` loads `.env` via `import "dotenv/config"`, which hands Prisma the literal string `${POSTGRES_PASSWORD}`; `e2e/db.ts`'s `envValue()` hand-parses the file and strips quotes with no `${...}` expansion at all, so it does the same. Both fail with a connection error that names nothing useful.

     So: **source `.env` into your shell before running any host-side script that touches the database.** Every such command block in this document — the migration, the seed, `bootstrap:admin`, `--reset-password` and the E2E suite — begins with the same prelude:

     ```bash
     set -a; . ./.env; set +a
     ```

     (`npm install`, `npx prisma generate` and `npx playwright install` do not touch the database and do not need it.) The alternative is to paste the literal password into the `DATABASE_URL` line instead of the `${...}` reference — then nothing needs expanding, but the password exists in a second place to keep in sync.

   **Public site address and TLS**
   - `SITE_ADDRESS` — **required, no default.** The public hostname Caddy serves and obtains a certificate for, e.g. `psa.yourmsp.com`. Hostname only: no scheme, no path, no port. Public DNS for this name must already resolve to this host, and inbound :80 must be reachable, before the first request can get a certificate.
   - `HTTP_PORT` / `HTTPS_PORT` — optional, defaulting to `80`/`443`. Only change them to run a second stack side by side on the same host. A stack on non-standard ports cannot answer either ACME challenge (HTTP-01 needs the real public :80, TLS-ALPN-01 the real public :443) and so cannot obtain a publicly-trusted certificate. Its `http://` → `https://` redirect is also wrong: Caddy builds the redirect target from the site address with the implied `:443`, so on an `HTTPS_PORT=8443` stack the redirect points at `https://host/` and lands nowhere. Reach a side-by-side stack over `https://host:8443` directly.

   **Auth**
   - `AUTH_SECRET` — generate with `npx auth secret` (or `openssl rand -hex 32`, matching `.env.example`). Required; compose refuses to start without it. Optionally `AUTH_SECRET_1`, `AUTH_SECRET_2` and `AUTH_SECRET_3` hold *retired* secrets during a rotation: `AUTH_SECRET` signs new sessions, the numbered slots are decode-only, so sessions minted under the old value keep working until you drop the slot. To rotate, move the current value into `AUTH_SECRET_1`, put the new one in `AUTH_SECRET`, run **`docker compose up -d app`**, and drop the slot once every session older than the 8-hour max age has expired. **Not `docker compose restart app`** — see "Rotating `AUTH_SECRET`" under Operational notes, which is the procedure to follow. Leave them unset unless you are mid-rotation. (This works only because `src/auth.config.ts` sets Auth.js's `secret` explicitly — Auth.js does not read these slots by itself in a next-auth app, and its own ordering would treat the highest-numbered slot as the signing secret. See `src/lib/auth-secrets.ts`.)
   - `AUTH_URL` — **required, no default, and shipped blank.** The public `https://` URL this deployment is reachable at, matching `SITE_ADDRESS` (e.g. `https://psa.yourmsp.com`), with no trailing slash. Compose fails fast if it is unset. It must be `https://`: Auth.js decides whether to use the `__Secure-` cookie prefix from this URL's protocol alone, and that protocol beats the `X-Forwarded-Proto` header Caddy sets, so an `http://` value behind TLS is not rescued by the proxy. This deployment no longer leaves that to chance — see "the cookie downgrade itself is no longer left to the guard" below — but `AUTH_URL` should still be correct, because it is also the URL Auth.js builds its own callbacks from.

     **Two things the `${AUTH_URL:?}` guard does not do for you.** It checks *presence*, not shape — `http://...`, a wrong hostname, or a trailing slash all pass the compose guard. And it only helps if the value is actually absent, which is why `.env.example` ships this blank alongside `POSTGRES_PASSWORD`, `SITE_ADDRESS` and `AUTH_SECRET`: an example value left in place by an operator who skimmed the file would satisfy the guard and start the stack on somebody else's hostname. Nothing downstream will catch a wrong *hostname* at all — check the value you typed.

     **The cookie downgrade itself is no longer left to the guard.** `src/auth.config.ts` pins `useSecureCookies: true` whenever `NODE_ENV=production`, which the shipped image sets, so the `__Secure-` prefix and the `Secure` attribute hold in production **regardless of what `AUTH_URL`'s scheme says**. The cookie cannot be downgraded by a typo any more.

     **Which also means a wrong `AUTH_URL` is now invisible in the cookie.** Measured, production build, identical in both arms: with `AUTH_URL=https://…` and with `AUTH_URL=http://…`, sign-in returns 302 and sets `__Secure-authjs.session-token` with the `Secure` attribute. Login does *not* fail, and the cookie name does *not* change. The **only** thing in this deployment that detects a non-`https` `AUTH_URL` is the startup warning:

     ```bash
     docker compose logs app --since 5m | grep '\[proxy\]'
     ```

     Look for `[proxy] AUTH_URL uses http://`. Read "Rate-limit threshold tuning" under Operational notes first for why that grep needs an HTTPS request made against the site before it can find anything. `AUTH_URL` still has to be right — Auth.js builds its callback and redirect URLs from it — but it is no longer what protects the cookie.
   - `AUTH_TRUST_HOST` — leave `true` unless you have a specific reason to change it; required for Auth.js to trust the host header behind a reverse proxy, which this deployment now always has.

   **Rate limiting** — all optional; leave unset to keep the defaults:
   - `RATE_LIMIT_WINDOW_MS` (default `60000`), `RATE_LIMIT_GENERAL` (default `60`), `RATE_LIMIT_AUTH` (default `10`). Read by `src/proxy.ts` once per `app` process. A value that is not a positive integer — including `0` — is rejected with a warning in `docker compose logs app` and the default is used instead: a typo cannot disable rate limiting.

   **Microsoft Graph API (email-to-ticket poller)** — required only if the `email-poller` service will be used, and **all four together or none**:
   - `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` — from an Azure AD app registration with `Mail.Read` (or `Mail.ReadWrite`) **application** permission, with admin consent granted.
   - `MAILBOX_ADDRESS` — the shared mailbox the poller reads from.

     `scripts/email-poller.ts` calls `requireEnv()` on each of the four at module load and throws if any is missing *or empty*, so a partially filled block is the same as an empty one. The service is behind Compose profile `email` and does not start unless you ask for it — see "Build and start" below.

   **QuickBooks Online integration** — required only if QBO push will be used:
   - `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` — from an Intuit developer app registration.
   - `QBO_ENVIRONMENT` — `sandbox` or `production`.
   - `QBO_REDIRECT_URI` — **shipped blank.** Must exactly match the redirect URI registered in the Intuit developer app, and must be `https://` (e.g. `https://psa.yourmsp.com/api/qbo/callback`). Only the host varies; the path is fixed by the callback route. It ships blank for the same reason `AUTH_URL` does — `src/lib/qbo.ts` uses this value verbatim, and an unedited example host fails at Intuit, on Intuit's page, with an error nothing here can explain.

     All five of these (the four above plus `TOKEN_ENCRYPTION_KEY`) are read from `process.env` inside the running `app` container, and `.dockerignore` excludes `.env` from the build context — so they reach the app **only** because `docker-compose.yml` names them in `app.environment`. If you add a new QBO-related variable later, adding it to `.env` alone does nothing; it must be named in `docker-compose.yml` too. Confirm what the container will actually receive with:

     ```bash
     docker compose config --no-interpolate | sed -n '/^  app:/,/^  [a-z]/p'
     ```

     > **`--no-interpolate` is not optional.** Without it `docker compose config` prints the *resolved* file, and that block now contains `AUTH_SECRET`, the three rotation slots, `TOKEN_ENCRYPTION_KEY`, `QBO_CLIENT_SECRET` and the `DATABASE_URL` with `POSTGRES_PASSWORD` embedded — every credential this deployment has, onto your terminal, into scroll-back, and into whatever screen-share or support ticket that output is pasted into. `--no-interpolate` answers the question you actually asked ("is the key named in the file?") and prints `${VAR}` placeholders instead of values. To confirm a key reached the *running* container without printing what it holds: `docker compose exec app env | cut -d= -f1 | sort`.

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

Confirm the services are running:

```bash
docker compose ps
```

You should see **three** services: `caddy` (the TLS-terminating reverse proxy, ports `${HTTP_PORT:-80}` and `${HTTPS_PORT:-443}`), `app` (the Next.js web application, **no published port** — reachable only as `app:3000` on the internal network), and `db` (Postgres 16, `127.0.0.1:${DB_PORT:-5432}`). Check logs for any of them with `docker compose logs -f <service>` if a service does not come up.

> **There are no healthchecks in this stack, by design.** No service defines `healthcheck:`, so `docker compose ps` reports `running`/`exited` and never `healthy`/`unhealthy`, and every `depends_on` resolves to `condition: service_started` — start *ordering* only, not readiness. That is a deliberate operator-facing trade-off rather than an oversight: migrations are run host-side after `up`, and Prisma reconnects on its own if `app` wins the race with `db`, so a readiness gate would buy ordering nothing here depends on. If you add one later, `db` is the service to add it to. There is also no `restart:` policy anywhere — see "Operational notes".

### The fourth service, `email-poller`, is opt-in

`email-poller` is behind Compose **profile `email`** and is deliberately not part of a default `up`. `scripts/email-poller.ts` calls `requireEnv()` for `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and `MAILBOX_ADDRESS` at module load, so on any deployment that does not use email-to-ticket it would start, throw, and sit in `Exited(1)` — and with no `restart:` policy anywhere in this stack it stays there, showing a permanently failed service in `docker compose ps` forever. A profile is preferable to teaching operators to ignore a red line.

If you *are* using email-to-ticket: fill in all four Azure values in `.env`, then start the stack with the profile flag:

```bash
docker compose --profile email up -d
```

> **Use the flag on every command that should include the poller.** Set `COMPOSE_PROFILES=email` in your shell (or in `.env`) if you would rather not repeat it. If you filled in the Azure block and the poller is simply not there, a missing flag is the reason.
>
> Compose's behaviour is not uniform across subcommands, and the difference matters most at shutdown. Measured on the Compose in use here (`docker compose version` reports **v5.1.1**; yours may differ, which is what the second caveat below is about), running each command **without** `--profile email` against a project whose poller was already started with it:
>
> | Command | Poller included? |
> |---|---|
> | `up -d` | **no** — not started (this is the point of the profile) |
> | `build` | **no** — not built |
> | `ps` | yes — listed, and listed as running |
> | `logs email-poller` | yes — works, exits 0 |
> | `restart` | **no** — the poller keeps its old uptime |
> | `stop` | **no** — ⚠ the poller keeps running |
> | `down` | **no** — ⚠ the poller keeps running; the network removal fails with `Resource is still in use`, **and the command still exits 0** |
>
> The two marked ⚠ are the ones that bite: **`docker compose stop` and `docker compose down` do not stop the poller** unless you pass the flag, so a shutdown you believe is complete leaves a container holding live Azure credentials and a live database connection. Always shut down with `docker compose --profile email down` (or with `COMPOSE_PROFILES=email` exported) on a deployment that runs the poller, and check `docker ps` afterwards — the exit status will not tell you, since the failed `down` returns 0. Setting `COMPOSE_PROFILES=email` in `.env` is the durable fix.
>
> **Two caveats on the table.** First, it is invocation-dependent: passing an explicit **`-p <project>` flag** flips the `stop`/`down`/`restart` rows, and those commands then **do** include the profiled service. It is the flag itself, not the project name: passing `-p` with the same name the directory already derives still flips them. `COMPOSE_PROJECT_NAME` in your environment or `.env` does **not** — measured, it behaves like the no-flag column and leaves the poller running. Most commands in this document use the implicit, directory-derived name, which is what the table measures; the backup-verification step under "Backup" is the one place that deliberately passes `-p`.
>
> Second, it is a single measurement on one Compose build, not a promise about yours. Treat the table as the evidence for the advice, not as a prediction: **always pass `--profile email` (or export `COMPOSE_PROFILES=email`), and always confirm with `docker ps` afterwards.** That instruction is correct whichever way your Compose version behaves.

If `docker compose up -d` refuses to start with `required variable ... is missing`, that is deliberate: `POSTGRES_PASSWORD`, `SITE_ADDRESS`, `AUTH_URL` and `AUTH_SECRET` have no defaults, because every default this project could have picked for them is a security downgrade. All four fail at `up`, before anything is serving, rather than at the first request that needs them.

### TLS: what happens on the first request

Caddy does **not** obtain a certificate at startup. It obtains one via ACME on the first request for `SITE_ADDRESS`. The shipped `Caddyfile` sets no `tls` and no `acme` directive, so Caddy keeps **both** of its default challenges enabled — **HTTP-01 on :80** and **TLS-ALPN-01 on :443** — and uses whichever succeeds. What must already be true:

1. Public DNS for `SITE_ADDRESS` resolves to this host, and
2. inbound TCP :80 is reachable from the public internet. This is the recommended configuration, not a hard requirement for issuance: TLS-ALPN-01 on :443 can complete on its own. But :80 is where the `http://` → `https://` redirect lives, and it is the fallback challenge if TLS-ALPN-01 fails — closing it removes both.

> **No publicly-trusted certificate was ever issued against this configuration.** Everything verified during Phase 8 used Caddy's **internal CA** answering for `localhost`, which does not exercise ACME, DNS, or either challenge. The steps below are the right steps; treat the outcome as unobserved and actually read the log.

Make that first request yourself and watch it happen:

```bash
curl -I http://<SITE_ADDRESS>/      # expect a 308 redirect to https://
docker compose logs -f caddy        # watch issuance; look for "certificate obtained successfully"
```

If issuance fails, Caddy keeps retrying in the background and the site serves no TLS in the meantime. The usual causes are DNS not yet propagated, :80 blocked at a firewall or router, or something else on the host already bound to :80. Note that certificates and the ACME account key live in the `caddy_data` volume — deleting it forces re-issuance, which can hit Let's Encrypt's rate limits, so do not prune it casually.

No `restart:` policy is set on any service in `docker-compose.yml`, so a container that exits stays down and nothing returns after a host reboot on its own — see "Stopping, restarting and backing up" below.

---

## Database migration

`npm run db:migrate:deploy` and `npm run test:e2e` (below) run on the **host**, not inside a container — Node.js must be installed on the host (any version meeting the Prerequisites above — it does **not** have to match the `node:20.20` pinned in `Dockerfile`, which governs only the image), and the project's dependencies must be installed there once:

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
2. `scripts/post-migrate.sh` then idempotently (`CREATE UNIQUE INDEX IF NOT EXISTS`) re-applies the one-active-timer-per-user partial index on `TimeEntry`, which Prisma's schema DSL cannot express directly and which `prisma migrate deploy` alone does not guarantee on a fresh environment (see the script's own header comment for the full history). It is safe to run repeatedly. **It needs `psql` on the host** (see Prerequisites) — it shells out to it, and without it step 1 still succeeds while step 2 dies at `psql: command not found`.

**Confirm both halves landed.** Step 1 announces itself in Prisma's output; step 2 prints `post-migrate.sh: TimeEntry_one_active_timer_per_user partial unique index verified/created.` on success. If you did not see that line — or want to check an existing deployment — query the index directly:

```bash
docker compose exec -T db psql -U postgres -d msp_psa -tAc \
  "select indexname from pg_indexes where indexname = 'TimeEntry_one_active_timer_per_user';"
```

The index name printed back means the constraint is in place. **Empty output means it is missing**, and nothing in the application will tell you: the index is what stops a user holding two running timers at once, so its absence shows up later as duplicate open time entries rather than as an error. Install `postgresql-client` and re-run `npm run db:migrate:deploy` — it is idempotent.

> **Do not substitute `\di+ TimeEntry_one_active_timer_per_user` here.** psql down-cases an unquoted `\d` pattern, so it searches for `timeentry_...` and never matches this mixed-case identifier: it prints `Did not find any relation named "TimeEntry_one_active_timer_per_user".` and exits 0 **whether the index exists or not** — verified against a live Postgres 16 with the index present and then dropped, byte-identical output both times. A check that cannot produce its own "good" state is worse than no check: it reads as a broken deployment forever. `\di+ "TimeEntry_one_active_timer_per_user"` (inner quotes) does work, but the `pg_indexes` query above is preferred because it is scriptable.

> **Warning — on an upgrade, this must complete before the `app` container restarts.** Application code that runs ahead of its schema does not fail partially here: `authorize()` selects every column, an absent column raises Prisma **P2022** on every request, and the login form reports "Invalid email or password" to everyone including every admin. See "Upgrades: order matters" — the next section — for the full explanation and the safe upgrade order.

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

## Upgrades: order matters — apply the migration *before* the app restarts

**Run `npm run db:migrate:deploy` (see "Database migration" above) and confirm it succeeded before starting or restarting the `app` and `email-poller` containers on any upgrade that includes new columns.** This is not a preference — with application code running ahead of its schema, this app does not degrade partially, it fails completely and misleadingly:

- `authorize()` (`src/auth.ts`) looks the user up with `findUnique` and **no `select` clause**, so Prisma asks Postgres for every column the current schema defines.
- If a column the code knows about does not yet exist in the database, Prisma raises **P2022** (`The column ... does not exist in the current database`) on that query — and therefore on *every* login attempt and every authenticated page load.
- `loginAction` translates any failure from `authorize()` into the same anti-enumeration message the wrong password produces: **"Invalid email or password"**. Every user sees it. **Including every admin.** There is no in-app escape hatch, no error detail, and nothing in the UI that says "run a migration": recovering requires shell access to the host and `docker compose logs app` (or `psql`) to see the real P2022 underneath.

So the safe upgrade order on an existing deployment is: pull → `npm install && npx prisma generate` → **`npm run db:migrate:deploy`** → `docker compose build` → `docker compose up -d`. On a brand-new deployment, `docker compose up -d` before the migration is harmless *provided nobody tries to log in* until `db:migrate:deploy` has run.

`scripts/create-admin.ts` (below) detects P2022 itself and prints this same guidance rather than a raw Prisma stack trace, so if you bootstrap the admin before restarting anything, the script tells you the migration is missing.

## Rotating the database password

`POSTGRES_PASSWORD` is applied by **initdb only** — the very first time the `pgdata` volume is created. On any deployment where that volume already exists, editing `.env` and restarting changes the credential the `app` and `email-poller` containers *present* and nothing about the credential Postgres *accepts*. The result is a stack where `db` is up and accepting connections, `app` fails to connect, and nothing anywhere says "the password you set was ignored". (`db` does not report *healthy* — nothing in this stack defines a healthcheck; see "Build and start".) This is the procedure that actually rotates it.

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
   docker compose up -d app
   ```

   **Add `email-poller` to that line only if you actually run the poller.** Naming a profiled service explicitly auto-enables its profile, so `docker compose up -d app email-poller` starts the poller on a deployment that has no Azure credentials — it throws at module load and sits `Exited(1)` forever, which is precisely the state profile `email` exists to prevent.

   `db` itself does not need restarting — `ALTER USER` took effect immediately. A rebuild is not needed either; these are environment values, not build inputs.

4. **Confirm**: `docker compose logs --tail=50 app` should show no connection errors, and the login page should load.

If you have already restarted into the broken state (new password in `.env`, old one in the volume), nothing is lost: put the **old** password back in `.env` temporarily, `docker compose up -d`, then run the `ALTER USER` above and follow the steps in order.

The alternative — deleting the `pgdata` volume so initdb runs again with the new password — **destroys every ticket, invoice, time entry and user account in the database.** It is only appropriate on a deployment that has never carried real data.

---

## Creating the first admin account and onboarding the team

> ### Before you onboard anyone: two checks
>
> Credentials and session cookies cross the network during onboarding, so confirm TLS is genuinely in effect first. Caddy terminates TLS, `app` publishes no host port, and `http://` redirects to `https://` — that part is structural. The two things an operator can still get wrong:
>
> **1. `AUTH_URL` must be an `https://` URL.** Compose rejects it when unset, but a value of `http://...` starts happily and the guard cannot tell the difference. It no longer affects the session cookie (see below), but Auth.js builds its callback and redirect URLs from it. The only detector is the startup warning:
>
> ```bash
> set -a; . ./.env; set +a                            # SITE_ADDRESS lives in .env, not your shell
> curl -sfk -o /dev/null "https://$SITE_ADDRESS/" || echo "REQUEST FAILED - fix this before reading the log"
> docker compose logs app --since 5m | grep '\[proxy\]'
> ```
>
> A `[proxy] AUTH_URL uses http://` line means fix `.env` and run `docker compose up -d app`.
>
> **2. The session cookie must be `__Secure-` prefixed.**
>
> Log in once and look at the session cookie in your browser's developer tools. **`__Secure-authjs.session-token`** is correct. A bare **`authjs.session-token`** means the app is not running with `NODE_ENV=production` — the shipped image sets it, so seeing the bare name in a container deployment means something is wrong with how the image was built or overridden, and sessions are travelling without the `Secure` attribute. Fix that before onboarding anyone.
>
> **It tells you nothing about `AUTH_URL`.** Measured in both arms: a correct `https://` value and a mistyped `http://` one both produce `__Secure-authjs.session-token` and a successful login, because `useSecureCookies` is pinned in production and no longer consults the URL. For `AUTH_URL` itself, use the `[proxy]` log line in check 1 above.
>
> **On upgrades from a pre-Phase-8 deployment, expect one forced logout.** A deployment that previously ran without `NODE_ENV=production`, or before `useSecureCookies` was pinned, issued bare `authjs.session-token` cookies. The cookie name is the encryption salt, so those sessions cannot be read under the `__Secure-` name and everyone is logged out once at the upgrade. That is expected, not a defect — the same class of event as Phase 7's `tokenVersion` rollout. Nobody's account, password or data is affected. (Changing `AUTH_URL`'s scheme alone does **not** do this any more, because the cookie name no longer depends on it.)

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

The demo-account seed is **no longer the documented way to create a real admin.** `prisma/seed.ts` still exists, but its guard rail has been **replaced** — the old `ALLOW_SEED_IN_PRODUCTION` override is no longer consulted at all, and the guard it gated on was never effective here (see below), but it is now a local-development tool only — see "First-run verification" below.

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

**Do not rely on the seeded demo users for a real deployment.** `prisma/seed.ts` creates five test accounts (`technician@mspdemo.local`, `dispatcher@mspdemo.local`, `sales@mspdemo.local`, `finance@mspdemo.local`, `admin@mspdemo.local`), all sharing a single well-known password (`Password123!`). It exists for local development and for the E2E suite's login fixture. **The seed script now refuses by default, everywhere.** It runs only with an explicit
`ALLOW_DEMO_SEED=true` in the environment — set it inline, for the one command:

```bash
set -a; . ./.env; set +a
ALLOW_DEMO_SEED=true npm run db:seed
```

Set `ALLOW_DEMO_SEED` **inline, for one command. Never put it in `.env`** — this document tells you to run
`set -a; . ./.env; set +a` before host-side commands, which would export it on the deployment
host and re-arm the script there, exactly the failure the gate prevents.

> **Why an explicit opt-in rather than an automatic check.** The previous guard fired only when
> `NODE_ENV=production`. That variable is set inside the app container (`Dockerfile`), and is
> **unset in your shell** — so it could never fire for a host-side `npm run db:seed`, which is
> how this script is actually run. A "refuse unless `DATABASE_URL` is localhost" check cannot
> replace it either: Postgres is published on `127.0.0.1`, so the production database is *also*
> reachable at localhost. Nothing the script can observe distinguishes your development database
> from this one. You can. `ALLOW_SEED_IN_PRODUCTION` is no longer read; delete it from any `.env`
> where it survives. Creating the real admin is `npm run bootstrap:admin`'s job, as described above; the previous guidance in this document (a modified seed run, or a hand-written `psql` insert) is obsolete and should not be followed.

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

Then seed the fixture accounts the suite requires and run it. **Both need `.env` sourced into your shell first** — the same prelude the migration uses, and for a slightly different reason worth knowing:

```bash
set -a; . ./.env; set +a
ALLOW_DEMO_SEED=true npm run db:seed
npm run test:e2e
```

`e2e/db.ts` does not use dotenv at all. Its `envValue()` reads `.env` by hand, takes everything after the first `=`, trims it and strips surrounding quotes — and performs **no `${...}` expansion**. Since `.env.example` ships `DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@..."`, an operator who copied the template and skipped the prelude hands Prisma the literal placeholder. `envValue()` prefers `process.env` when it is set, so exporting first is what makes it read the real value. `npm run db:seed` goes through `prisma7.config.ts` and dotenv, which has the same non-expansion behaviour.

`npm run test:e2e` runs the **gate**: all three projects — `lifecycle`, `advisory` and `last-active-admin`, **53 tests across 7 files**. (`advisory` joined the gate in Phase 9; before that the gate was `lifecycle` + `last-active-admin` only, at 45 tests.) Per `playwright.config.ts` it starts its own `next dev` on port **3100** (override with `E2E_PORT`) — it will not reuse a server already listening, and a build-identity check in `e2e/global-setup.ts` aborts the run if the server answering is not built from the current source. That check exists because an earlier configuration silently graded a stale container image.

> **This suite is for a local development database only. Do not point it at staging or production.**
>
> `e2e/global-setup.ts` and `e2e/global-teardown.ts` **delete** rows matching `e2e-lifecycle-%@e2e.invalid`, and require the five `*@mspdemo.local` seed accounts to exist — a database bootstrapped with `npm run bootstrap:admin` has none of them, so teardown will fail with a message about fixture accounts that names the wrong cause. Run this against a database seeded by `ALLOW_DEMO_SEED=true npm run db:seed`, on a machine you are developing on.
>
> For a pre-promotion check against staging, exercise the flows by hand using the onboarding steps above rather than running this suite.

`npm run test:e2e:advisory` runs the `advisory` project on its own — **8 tests in 3 files** (`tickets`, `sla-tracking`, `time-entry-to-invoice`). The project name and the "three pre-Phase-7 specs" label are historical and now undercount it: those three *files* predate Phase 7, but three of the eight tests — the ticket-delete cases — were written in Phase 9.

`advisory` was kept out of the gate while it was red, because Playwright's exit code is per-process, not per-project, so a red project makes the whole gate permanently red and destroys its signal. **Phase 9 fixed the specs**, so that reasoning no longer applies and `advisory` is now part of `npm run test:e2e` (45 tests → 53).

`npm run test:e2e:all` is an **alias** for `npm run test:e2e`, not a superset: `test:e2e` names all three projects explicitly and `playwright.config.ts` defines no fourth, so both select the same 53 tests in the same 7 files. It is kept only because existing scripts and docs refer to it; if a project is ever added that is deliberately outside the gate, this is the script that must change.

**CI runs with `retries: 2`** (`playwright.config.ts`, `process.env.CI ? 2 : 0`), so a line reported as **flaky** in CI means a test failed and then passed on a retry — a real finding to investigate, not noise to discount. Retries make an intermittent failure much harder to see: a test that fails independently 1 run in 4 is reported green roughly 98% of the time under two retries. Treat any `flaky` count above zero as a failure that has not been diagnosed yet.

Known gaps, intentional and documented in the specs themselves:
- `scripts/create-admin.ts` has no automated test: it is gated on an interactive TTY, so it cannot be driven by the suite as written. Its behaviour is evidenced only by a manual transcript.

---

## Stopping, restarting and backing up

### Stopping

```bash
docker compose stop          # stop containers, keep them and all volumes
docker compose start         # bring them back
docker compose restart app   # restart one service IN PLACE -- keeps the old environment
docker compose down          # stop AND REMOVE containers + the network; volumes SURVIVE
```

> **`restart` does not pick up `.env` changes.** A container's environment is fixed when it is created, so `restart` reuses it and silently keeps the old values while printing `Started` and exiting 0 — measured. After editing `.env`, always use `docker compose up -d <service>`, which recreates. This matters most for `AUTH_SECRET` (see "Rotating `AUTH_SECRET`") and the `RATE_LIMIT_*` overrides, where the no-op is indistinguishable from success.

`docker compose down` is safe: `pgdata`, `caddy_data`, `caddy_config` and `poller_state` are named volumes and are **not** removed. `docker compose up -d` afterwards brings everything back with its data intact.

> ### `docker compose down -v` destroys this deployment's data
>
> The `-v` flag removes the named volumes too. That is **two keystrokes** from the safe form above, and it deletes:
>
> - **`pgdata`** — every ticket, client, contract, invoice, time entry and user account. There is no undo and this repository ships no automated backup that would cover you.
> - **`poller_state`** — the email poller's watermark. Losing it is the quietest of the three: `scripts/email-poller.ts` deliberately does not backfill, so it resumes from `now()` and **every message that arrived before the volume was destroyed is never turned into a ticket**, with no error and no gap report. Only relevant if you run the `email` profile, and only destroyed by `-v` (verified).
> - **`caddy_data`** — the issued TLS certificate **and the ACME account key**. Re-issuance then happens from scratch on the next request, which counts against [Let's Encrypt's rate limits](https://letsencrypt.org/docs/rate-limits/) (notably 5 duplicate certificates per week). Repeatedly recreating a stack can lock you out of issuance for days, with the site serving no TLS meanwhile.
>
> If your goal is "restart cleanly", `docker compose down && docker compose up -d` already does that. Reach for `-v` only to deliberately destroy a deployment that has never held real data. The same applies to `docker volume prune` and `docker system prune --volumes`.

If you are running the email poller, add the profile flag so it is included: `docker compose --profile email down`. Without it, a running `email-poller` is left behind — **and `down` still exits 0 and prints nothing that looks like a failure**, so the only way to know is to check. After any shutdown on a poller deployment:

```bash
docker compose --profile email down
docker ps            # must list nothing from this project
```

### Backup

**This repository ships no automated backup.** There is no cron job, no backup service in `docker-compose.yml`, and no retention policy anywhere in this project. Standing one up is the operator's responsibility, and until it exists this deployment has no recovery path from a `down -v`, a disk failure or a bad migration.

A manual logical dump, run on the host, needs no host-side `DATABASE_URL` because `pg_dump` runs inside the `db` container:

```bash
BACKUP="msp_psa-$(date +%Y%m%d-%H%M%S).sql"
if docker compose exec -T db pg_dump -U postgres -d msp_psa --clean --if-exists > "$BACKUP"; then
  echo "backup ok: $BACKUP ($(wc -c < "$BACKUP") bytes)"
else
  echo "BACKUP FAILED -- removing the empty file"; rm -f "$BACKUP"
fi
```

> **Do not drop the `if`.** The shell creates the redirect target *before* `pg_dump` runs, so the bare `pg_dump ... > file` form leaves a **zero-byte file with a perfectly valid-looking timestamped name** whenever the dump fails — measured with `db` stopped: `pg_dump` exits 1, stderr says `service "db" is not running`, and `msp_psa-….sql` is sitting in the backup directory. A file named like last night's backup, holding nothing. For a document whose own thesis is that an untested backup is not a backup, checking the exit status is the minimum.
>
> To sanity-check a dump you already have, look at the **last** lines rather than the first — a dump that died partway through still opens with a perfectly normal `-- PostgreSQL database dump` header. A complete dump from `pg_dump` 16 ends with both of these, in this order (measured on 16.15):
>
> ```
> -- PostgreSQL database dump complete
> --
>
> \unrestrict <token>
> ```
>
> Older `pg_dump` versions emit the `complete` line without the `\unrestrict` line. Either way, a file that ends mid-statement has neither.

Dumps are written to whatever directory you run this from, which for every command in this document is the repository root. `.gitignore` covers `msp_psa-*.sql` so a dump is never committed by accident — but it is still an unencrypted copy of every ticket, client, invoice and password hash sitting in a checkout. Move it somewhere encrypted, and do not leave it there.

Restore (this **overwrites** the current contents of `msp_psa`). **Stop the application first** — do not restore into a stack that is still serving:

```bash
docker compose stop app                       # and the poller, if you run it
docker compose exec -T db psql -U postgres -d msp_psa \
  -v ON_ERROR_STOP=1 --single-transaction \
  < msp_psa-YYYYMMDD-HHMMSS.sql
docker compose start app
```

> **Why `stop app` and not "restore into a running stack".** The dump begins with `--clean` statements that need an `AccessExclusiveLock`, and **any** application session sitting in an open transaction holds a conflicting `AccessShareLock` that blocks it. The restore then prints its short `SET` preamble and **stops with no further output** until the transaction ends. Measured, so you can reproduce both halves: a connection that has run a query and gone genuinely idle (`pg_stat_activity.state = 'idle'`) holds **no** relation locks and the restore completes in about a second — but one session left `idle in transaction` blocks it indefinitely (killed at a timeout). A serving `app` opens and closes transactions continuously, so whether a restore succeeds or hangs is a race you do not want to run during an incident.
>
> When it does block, the queued exclusive-lock request blocks every subsequent application query behind it, so attempting recovery takes the site down harder than the incident did. Note that an *idle* connection alone will not reproduce this — the restore completes in about a second — so do not treat one successful test as licence to skip the step.
>
> **`--single-transaction` is the other half.** Without it, a failure partway through `ON_ERROR_STOP=1` leaves a half-dropped schema with no way back; with it, a failed restore rolls back to the pre-restore state. Verified by killing a blocked restore mid-flight: the database was left completely intact.

Four things the database dump does **not** cover:

1. **`.env`** — `POSTGRES_PASSWORD`, `AUTH_SECRET` and every integration secret. Back it up separately, encrypted, mode `0600` at rest, and never into the same bucket as the dump.
2. **`TOKEN_ENCRYPTION_KEY` specifically.** QuickBooks access/refresh tokens are stored encrypted in the database, so a dump restored **without** the matching key leaves those rows undecryptable and the QBO connection must be re-established at `/admin/quickbooks`. The database being intact is not sufficient.
3. **`caddy_data`.** Not worth backing up — Caddy re-issues — but see the **Let's Encrypt** rate-limit warning above (not the application's `RATE_LIMIT_*` limiter) before destroying it casually.
4. **`poller_state`.** Only relevant on an `email`-profile deployment. It is a single timestamp, so it is not worth a backup either — but restoring a database dump does **not** rewind the poller, and the two can disagree: mail polled after the dump was taken is gone from the restored database while the watermark still says it was processed. After any restore on a poller deployment, stop the poller, delete `poller_state`, and let it resume from `now()` rather than re-reading mail it has no tickets for.

**An untested backup is not a backup.** Restore one into a scratch stack (a separate `DB_PORT`, a separate project name via `-p`) and log in against it before you rely on this procedure — on *your* data, which is the only test that counts.

The procedure itself is no longer unobserved. It was round-tripped end to end during Phase 8 review: dump, delete rows, run the restore block verbatim, and the users came back, `/login` answered 200, and the `TimeEntry_one_active_timer_per_user` partial index returned with the dump (it is carried in the dump, so no `post-migrate.sh` re-run is needed afterwards). A restore killed mid-flight left the database completely intact, which is what `--single-transaction` is there for.

### After a host reboot

No `restart:` policy is set on any service. Nothing comes back on its own: run `docker compose up -d` (plus `--profile email` if used). If this deployment must survive reboots unattended, add `restart: unless-stopped` to each service in `docker-compose.yml` or manage the stack with a systemd unit — a deliberate operator decision this repository does not make for you.

---

## Rotating `AUTH_SECRET`

Rotate when the secret may have been exposed — a leaked `.env`, a departed administrator who had host access, or a routine schedule. Done correctly this is invisible to users; done with the wrong command it silently does nothing, and done without the rotation slot it logs everyone out.

1. **Generate the new secret** and edit `.env` so the *old* value moves into the slot:

   ```
   AUTH_SECRET=<new value from `npx auth secret`>
   AUTH_SECRET_1=<the value AUTH_SECRET had until now>
   ```

   `AUTH_SECRET` signs new sessions; `AUTH_SECRET_1` is decode-only, so sessions issued under the old value keep working.

2. **Recreate the container:**

   ```bash
   docker compose up -d app
   ```

   > **Not `docker compose restart app`.** `restart` reuses the existing container, and a container's environment is fixed when it is created — so `restart` keeps the *old* secret while printing `Started` and exiting 0. Measured: after editing `.env` and running `restart`, the container still had the old `AUTH_SECRET` and no `AUTH_SECRET_1` at all. Every signal says it worked. Nobody gets logged out, which is also the success criterion for a correct rotation, so the two are indistinguishable from the outside. You would then drop `AUTH_SECRET_1` on schedule, and the next unrelated recreate would apply the new secret with no decode slot left — logging everyone out weeks later, with the compromised secret live the whole time.

3. **Verify it actually took effect**, which is the step that separates the two cases:

   ```bash
   docker compose exec app sh -c 'printenv AUTH_SECRET | sha256sum; printenv AUTH_SECRET_1 | sha256sum'
   ```

   Two digests must print. Compare them against `printf '%s\n' "$NEW" | sha256sum` and the old value's digest — the first must match the new secret, the second the retired one. **Digests, not the values**: rotation is an incident activity and this is exactly the moment someone is screen-sharing, so do not `printenv` these straight to a terminal. (If a variable is unset, `printenv` prints nothing and you get the digest of an empty string, `e3b0c442…` — which is the failure signature for "the container was not recreated".) Then confirm a session predating the rotation still resolves: stay logged in in an existing browser tab and reload a page — you should not be sent to `/login`.

4. **Drop the slot** once every session older than the 8-hour `maxAge` has expired: remove `AUTH_SECRET_1` from `.env` and run `docker compose up -d app` again.

Rotating `TOKEN_ENCRYPTION_KEY` has no equivalent safe procedure: QuickBooks tokens are encrypted at rest with it, so changing it makes existing stored connections undecryptable and QuickBooks must be re-connected at `/admin/quickbooks`. There is no second-slot mechanism for that key.

## Operational notes

- **`DB_PORT` per-environment convention**: still meaningful. The `db` service publishes `127.0.0.1:${DB_PORT:-5432}:5432` — loopback-scoped rather than removed, so Postgres is reachable from this host (which `db:migrate:deploy`, `db:seed`, `bootstrap:admin` and the E2E suite all need) and from nowhere else on the network. `.env.example` documents `DB_PORT` as a value to vary per checkout/worktree so multiple instances of this stack (e.g. a staging environment alongside production on the same host) don't collide on the same host Postgres port; that convention keeps working unchanged. For a single production deployment the default `5432` is fine. If you stand up a second instance, give it a distinct `DB_PORT` (e.g. `5433`) and a distinct `DATABASE_URL` to match — and distinct `HTTP_PORT`/`HTTPS_PORT`, remembering that ACME needs the real public ports — only the stack holding :80 can answer HTTP-01, and only the stack holding :443 can answer TLS-ALPN-01, so a second stack on `8080`/`8443` gets no publicly-trusted certificate at all.

- **Rate-limit threshold tuning**: the thresholds are read from the environment once per `app` process, so retuning them costs a restart — **not** a rebuild, and no source edit. The three variables and their defaults:

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

  Raise `RATE_LIMIT_GENERAL` if legitimate traffic from a NAT'd office (many technicians sharing one public IP) is being throttled; lower `RATE_LIMIT_AUTH` to tighten brute-force protection on an internet-exposed deployment. A value that is not a positive integer is **rejected**, not obeyed: `0`, a negative, a fraction, an empty string or anything non-numeric falls back to the default and logs a `[proxy]` warning naming the variable, the offending value and the default applied. Check for the warning like this, after the restart:

  ```bash
  set -a; . ./.env; set +a                          # SITE_ADDRESS lives in .env, not your shell
  curl -sfk -o /dev/null "https://$SITE_ADDRESS/" || echo "REQUEST FAILED - fix this before reading the log"
  docker compose logs app --since 5m | grep '\[proxy\]'
  ```

  **The request is not optional, and it must be `https://`.** These warnings are emitted once per process, and Next.js instantiates the proxy module lazily on the first request Next routes through its server pipeline — measured on Next 16.3.3: a freshly restarted `app` logs nothing at all until traffic arrives. An operator who restarts during a maintenance window and greps the log before re-admitting traffic gets an empty result and concludes the value was accepted.

  > **Why not `http://`.** The `Caddyfile` has one site block and no `:80` block, so Caddy's automatic-HTTPS redirect vhost answers **every** plaintext request with a 308 at the edge — measured: `curl http://127.0.0.1:${HTTP_PORT}/`, and the same request carrying `Host: $SITE_ADDRESS`, both return 308 and **neither reaches `app`**. The proxy module never loads and the grep is then empty for exactly the wrong reason. Use the site's own hostname over HTTPS. **`SITE_ADDRESS` is not in your shell** unless you source `.env` first — Compose reads that file, your shell does not — and a bare `curl -s -o /dev/null "https://$SITE_ADDRESS/"` against an empty variable exits 3 in complete silence, leaving the grep below empty for a third wrong reason. Hence `set -a` and `-f`. `-k` is only needed while the certificate is Caddy's internal CA; drop it once a public certificate is issued. If DNS does not point here yet: `curl -sfk --resolve "$SITE_ADDRESS:443:127.0.0.1" "https://$SITE_ADDRESS/"`.

  `--since` guards the other end: container logs are capped (see "Log retention" below), so an old warning can be rotated away and also read as clean. A typo cannot disable rate limiting, but it can leave you thinking a change took effect when it did not.

- **Ticket deletion is admin-only, and refuses invoiced time**: the ticket detail page carries a "Danger zone" section with a confirmation dialog, rendered for `admin` only. `deleteTicket` is gated on `ADMIN_MANAGE_ROLES` server-side — hiding the control is a UX courtesy, not the boundary; a non-admin who invokes the action directly is redirected to `/unauthorized`. Phase 6's technician-ownership rule is gone, superseded in Phase 9: deleting a ticket destroys billing history, so it belongs to the role accountable for that data. **Confirming the dialog also deletes the ticket's comments and its time entries** (both relations are `onDelete: Cascade`), which is why the dialog states the counts. If any of that time has already been invoiced the delete is refused up front, naming the invoice by company, period and status — `model Invoice` has no invoice-number field. Operators should treat this as irreversible: there is no soft-delete, no archive and no audit record of who deleted what.

- **Account management exists; self-service signup does not**: this gap is closed for the operator's purposes. `npm run bootstrap:admin` creates the first admin (no seed run, no hand-written insert), and `/admin/users` handles create / change-role / reset-password / deactivate / reactivate for everyone after that — see "Creating the first admin account and onboarding the team" above. What still does not exist, deliberately: **self-service signup** (accounts are only ever created by an admin), **self-service password reset** (a locked-out user needs an admin; a locked-out *sole admin* needs host shell access and `npm run bootstrap:admin -- --reset-password`), **email invitations** (temporary passwords are shown once on screen and delivered by the admin out of band), and **an audit log** — any admin may reset, demote or deactivate any other admin, and the only trace is an unstructured line in the `app` container's stdout. Plan for admin accounts accordingly: they are mutually trusting, and `docker compose logs app` is not a tamper-evident record — nor, since the log caps below, a durable one.

- **Log retention is capped at 50 MB per service**: all four services set `logging: json-file` with `max-size: 10m` / `max-file: 5` (`docker-compose.yml`). Without a cap, Docker's default json-file driver grows without limit on the same filesystem as the `pgdata` volume, and Caddy writes an access-log line per request *before* authentication — so an unauthenticated client could fill the disk Postgres writes to. The cost of the cap is that everything above rolls: the admin-account-change lines that stand in for an audit log, and the one-shot `[proxy]` configuration warnings, are a rolling window, not a record. If you have a retention or audit obligation, ship these logs off-host (any Docker logging driver, or a sidecar tailing the json files) — that is the fix, not raising `max-size`.

- **QuickBooks Item-mapping caveat**: `src/lib/actions/invoices.ts` (around line 352-367, `SalesItemLineDetail`) hardcodes `ItemRef.value` to `"1"` for every invoice line pushed to QuickBooks Online. QBO requires each line to reference a real `Item` entity configured in the target QBO company (commonly the default "Services" item, which is often ID `1`, but this is **not guaranteed** across every QBO company/chart-of-accounts configuration). This codebase has no Item-mapping concept — it does not look up or let the operator configure which QBO Item ID each invoice line should reference. **Before relying on QBO push in production, confirm that ID `1` actually resolves to a valid, appropriate Item in your specific QBO company** (check via QBO's own UI or API), or invoice pushes will fail or post against the wrong item. This is a known, accepted limitation carried into Phase 6, not something this phase's scope included fixing.

- **Rebuilding after code changes**: **apply migrations first.** The full, safe sequence is under "Upgrades: order matters" — read it before your first upgrade, because getting this backwards raises Prisma **P2022** on every request and reports "Invalid email or password" to everyone including every admin, with no in-app way back. In short: `npm run db:migrate:deploy` from the host, *then* `docker compose build`, *then* `docker compose up -d` (Compose will recreate only the containers whose image changed).
