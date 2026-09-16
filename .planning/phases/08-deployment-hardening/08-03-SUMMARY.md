# Plan 08-03 — Caddy + Compose Hardening — SUMMARY

**Status**: Complete with Warnings
**Wave**: 2
**Agent**: engineering-infrastructure-devops + engineering-security-engineer
**Date**: 2026-09-16
**Requirements**: Caddy fronts the app with HTTP-01 TLS and `app` publishes nothing; default `postgres:postgres` replaced in all three places; `db` no longer reachable off-host

The warning is one stale assertion in this plan's own `<verification>` block, superseded by
the user-approved loopback deviation. Not a defect in the work — see below.

## Files

| File | Change |
|------|--------|
| `Caddyfile` | **New.** HTTP-01 TLS for `{$SITE_ADDRESS}`, `reverse_proxy app:3000`, and the mandatory `header_up X-Forwarded-For {remote_host}` trust-boundary directive. |
| `docker-compose.yml` | `caddy` service (80/443, overridable, `caddy_data`/`caddy_config` volumes). `app.ports` removed. `db.ports` → loopback. All three credential sites → `${POSTGRES_PASSWORD:?…}`. `AUTH_URL` → `:?`. `app.environment` → list form with the three `RATE_LIMIT_*` keys. |
| `.env.example` | `POSTGRES_PASSWORD` (hex generation + URI-safety rationale), `SITE_ADDRESS`, `HTTP_PORT`/`HTTPS_PORT`, three `RATE_LIMIT_*`, `AUTH_URL`/`QBO_REDIRECT_URI` → https, `DATABASE_URL` off the default credential, `DB_PORT` comment for loopback, Intuit warning, dotenv-expansion warning. |

No source file touched.

## The X-Forwarded-For finding — and a correction

**The coordinator's earlier claim that `reverse_proxy` appends by default was WRONG.**
Verified live against `caddy:alpine` **v2.11.4**, forging
`X-Forwarded-For: 66.66.66.66, 7.7.7.7` through each config:

| Config | Upstream saw |
|--------|-------------|
| bare `reverse_proxy` (Caddy default) | `172.18.0.1` — forged chain **dropped** |
| `+ trusted_proxies 0.0.0.0/0`, no `header_up` | **`66.66.66.66, 7.7.7.7, 172.18.0.1`** — forged value **first** |
| shipped `Caddyfile` (`header_up`) | `172.18.0.1` — dropped unconditionally |

Caddy documents that it "will ignore their values from incoming requests, to prevent
spoofing" *by default*
(<https://caddyserver.com/docs/caddyfile/directives/reverse_proxy>). So the default is
already safe — but **conditionally**: the moment any `trusted_proxies` range covers the
peer, Caddy forwards the full incoming chain, untrusted left-most entry included
(caddyserver/caddy#6783). `getClientIp()` reads
`forwardedFor.split(",")[0]` — precisely that entry.

`header_up X-Forwarded-For {remote_host}` removes the condition: position 0 is always
Caddy's own observation of the peer, regardless of version or any future `trusted_proxies`
line. Row B is what makes this defense-in-depth rather than redundant — `trusted_proxies
private_ranges` is the single most commonly pasted Caddy snippet, and `caddy:alpine` is a
floating tag.

`trusted_proxies` changes only what Caddy **logs** as `client_ip`; it does not sanitise
what is forwarded. None is configured, since Caddy is the first hop.

**Grep 08-04 is stop-gated on**: `grep -qE 'header_up +X-Forwarded-For' Caddyfile` → exit 0
(`Caddyfile:40`).

## Credential sites — before / after

| # | Location | Before | After |
|---|----------|--------|-------|
| 1 | compose `app.DATABASE_URL` | `postgres:postgres@db:5432` | `${POSTGRES_PASSWORD:?…}` |
| 2 | compose `email-poller.DATABASE_URL` | `postgres:postgres@db:5432` | `${POSTGRES_PASSWORD:?…}` |
| 3 | compose `db.POSTGRES_PASSWORD` | `postgres` | `${POSTGRES_PASSWORD:?…}` |
| 4 | `.env.example:6` `DATABASE_URL` | `postgres:postgres@localhost:5432` | `${POSTGRES_PASSWORD}@localhost:${DB_PORT}` |

Site 4 matters: P8-6 is **not** satisfied by fixing compose alone — `.env.example` is the
file operators actually copy. `AUTH_URL` went from `${AUTH_URL:-http://localhost:3000}` to
`${AUTH_URL:?…}`. No `:-` default on either. Generator is `openssl rand -hex 32`;
`rand -base64` appears nowhere.

## Verified topology (coordinator re-ran `docker compose config`)

```
app ports      : (none)
db ports       : 127.0.0.1:5432->5432
caddy ports    : 80->80, 443->443
RATE_LIMIT keys: {'RATE_LIMIT_AUTH': None, 'RATE_LIMIT_GENERAL': None, 'RATE_LIMIT_WINDOW_MS': None}
services       : app, caddy, db, email-poller
```

Guards fire individually — with nothing set, `docker compose config -q` exits 1 with
`required variable SITE_ADDRESS is missing`.

## RATE_LIMIT plumbing — list form, verified live

`app.environment` converted wholesale to list form (Compose forbids mixing forms in one
service). Bare keys `- RATE_LIMIT_WINDOW_MS`, `- RATE_LIMIT_GENERAL`, `- RATE_LIMIT_AUTH`.

Proven by a live `docker compose run … printenv`:

| Form | var set | var unset |
|------|---------|-----------|
| list `- RATE_LIMIT_AUTH` | `SET=[3]` | **ABSENT** |
| mapping `RATE_LIMIT_AUTH: ${RATE_LIMIT_AUTH}` | `SET=[3]` | `SET=[]` — **empty string injected** |

Empty is a *rejected* value in 08-02's `envInt`, so the mapping form would log three
`[proxy] …=""` warnings at every default start. List form omits the key, which `envInt`
treats as unset and leaves silent. Chosen over `${VAR:-10}` so defaults live in exactly one
place (`src/proxy.ts`) and cannot drift.

## db port — approved deviation, restated

`- "127.0.0.1:${DB_PORT:-5432}:5432"`, rendering as `127.0.0.1:5432->5432`.

The ROADMAP criterion says *removed*. Literal removal strands `db:migrate:deploy`,
`db:seed`, `bootstrap:admin` and the E2E suite: the runner is `node:20.20-alpine` with no
`bash`/`psql`, so the `docker compose exec` path DEPLOYMENT.md:129 offers has never worked,
and `bootstrap:admin` refuses non-interactive exec (DEPLOYMENT.md:185). Loopback closes the
exposure — unreachable from anywhere but the host — while keeping host tooling working.
User-approved. **08-04 documents this as the topology of record.**

## Verification

31 commands run, 30 passed, 1 failed.

The failure is this plan's own `<verification>` line asserting `'ports' not in s['db']` —
the literal-removal wording the approved deviation supersedes. The executor correctly
refused to "fix" it, since the only way to satisfy it is deleting the loopback mapping.
The frontmatter `verification_commands` and Task 2's `<verify>` both encode the approved
behaviour (`startswith('127.0.0.1:')`) and both pass. **The stale line has been corrected in
the plan file** so it cannot mislead a re-run.

## Carried forward — for 08-04

1. **NEW: dotenv does not expand `${…}`.** `prisma7.config.ts` uses `import "dotenv/config"`
   (dotenv 17.4.2), which returns the literal `postgresql://postgres:${POSTGRES_PASSWORD}@…`.
   An operator who copies `.env.example` and runs `npm run db:migrate:deploy` **without**
   sourcing `.env` first hands Prisma a placeholder and gets a connection error. `docker
   compose` expands it; `set -a; . ./.env; set +a` expands it, and dotenv does not override
   an exported variable, so the Prisma scripts then see the right value. **08-04 must carry
   the `set -a` prerequisite into the migration section** — DEPLOYMENT.md currently mentions
   it only under `bootstrap:admin`.
2. **Docker source-IP preservation.** Visible in the coordinator's own test: upstream saw
   `172.18.0.1`, the bridge gateway, because the request came through a published port. If
   the daemon routes via the userland `docker-proxy`, every request looks like the gateway
   and `header_up …{remote_host}` would key the whole internet into one bucket. Standard
   iptables DNAT preserves the client IP. Worth a runbook line and a post-go-live check
   (`docker compose logs caddy`, confirm varied `remote_ip`).
3. **`caddy:alpine` is a floating tag.** Verified against 2.11.4; the `header_up` directive
   is what makes the boundary version-independent. Pinning a digest is a reasonable
   follow-up.
4. **Existing `pgdata` volume** needs `ALTER USER` — `POSTGRES_PASSWORD` applies at initdb
   only. Noted in `.env.example`; 08-04 documents the procedure.
5. **No `restart:` policies** were added — outside this plan's minimal diff, worth raising.

## Errors

None.
