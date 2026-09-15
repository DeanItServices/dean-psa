# Phase 8: Deployment Hardening — Context

**Goal**: Make the self-hosted deployment safe to expose — real TLS, a reverse proxy that
makes the existing rate limiter meaningful, and no default credentials.

**Milestone**: Launch Readiness (v1 Go-Live), phases 7-9. Phase 7 shipped (PR #20).

## Sources of record

| Source | Carries |
|--------|---------|
| `.planning/explorations/2026-09-02-launch-readiness-design.md` | The locked decisions, rejected alternatives, and verified line references. **Read before planning or executing.** |
| `.planning/specs/08-deployment-hardening-spec.md` | This phase's spec — contracts, failure modes, acceptance checks, open questions with defaults |
| `.planning/CODEBASE.md` + `.planning/codebase/` | Refreshed 2026-09-15 at `b4c6dd2`, fingerprint verified fresh |

## Requirements

REQUIREMENTS.md is absent between milestones. Requirements come from ROADMAP.md's six
Phase 8 success criteria plus the exploration doc's "Deployment hardening" MVP block.
See the spec's Requirements table (P8-1 … P8-8).

## Existing assets

| Asset | State | Relevance |
|-------|-------|-----------|
| `src/middleware.ts` | 303 lines, Edge convention Next.js 16 deprecated | Becomes `src/proxy.ts` |
| Rate limiter | Hardcoded 60s / 60 / 10 at `:56-58` | Becomes env-read |
| `getClientIp()` | Returns `string \| null`; null skips limiting | Trust-boundary comment becomes true once Caddy lands |
| `config.matcher` | `/((?!_next/static\|_next/image\|favicon.ico).*)` | **Widened twice. Do not narrow.** |
| `docker-compose.yml` | 35 lines, 3 services, `postgres:postgres` ×3, app on `3000:3000` | Caddy added, ports and credentials fixed |
| `DEPLOYMENT.md` | 282 lines, carries `<!-- Phase 8: revisit for Caddy/TLS topology -->` at :143 | Topology rewritten, TLS precondition retracted |
| `.env.example` | 41 lines | New secrets and site address |

## Decisions

| Decision | Choice | Source |
|----------|--------|--------|
| Architecture proposals | **Skipped** — approach locked in the exploration doc | User, plan step 3.5 |
| Spec pipeline | **Run** — produced `.planning/specs/08-deployment-hardening-spec.md` | User, plan step 3.6 |
| TLS challenge | HTTP-01, stock `caddy:alpine` | Exploration doc, session 2 |
| Ordering | Proxy migration **before** env-read rate limits | Edge inlines `process.env` at build time; Node reads at runtime |
| `db` port | **Loopback bind `127.0.0.1:${DB_PORT}:5432`** (revised after critique) | Literal removal strands migrations, seed, bootstrap and E2E — alpine has no `bash`/`psql`, and `bootstrap:admin` refuses non-interactive exec. Loopback closes the exposure and keeps host tooling working |
| Codemod | Best-effort, then diff and hand-correct | ~180 lines of load-bearing comments will not survive a codemod |
| `auth.config.ts` | Keep the split; correct only the docstring | Split is still good design after Edge stops being a constraint |

## Constraints carried into execution

1. **`node_modules` was absent during planning**, so `proxy.md`'s runtime claims could not
   be re-verified. AGENTS.md requires reading `node_modules/next/dist/docs/` before writing
   code — 08-01 Task 1 does this explicitly and is a stop gate.
2. **Never narrow `config.matcher`.** It was widened in plan critique (for `/api/auth/*`)
   and again in Phase 7 review cycle 2 (for `/login`, where the credential POST actually
   lands). Narrowing silently removes brute-force protection.
3. **`QBO_REDIRECT_URI` must be re-registered at Intuit** after the scheme changes. No code
   change covers this; its failure mode is an opaque third-party error.
4. **`AUTH_URL` must become `https://`** or Auth.js issues a non-Secure cookie over TLS.
   Changing the scheme logs every existing session out once — expected, not a defect.
5. **`POSTGRES_PASSWORD` applies only at initdb.** An existing volume needs `ALTER USER`.
6. **Generate the password URL-safely** (`openssl rand -hex 32`). It is embedded in the
   `DATABASE_URL` URI, where base64's `/ + =` break parsing — and `db` starts healthy
   regardless, so only `app` fails.
7. **Compose `.env` does not reach containers.** `app.environment` enumerates its keys, so
   08-03 must plumb `RATE_LIMIT_*` through explicitly or 08-02's reads are always `undefined`
   in the shipped topology and the control silently stays at its defaults.
8. **`AUTH_URL` must fail fast in compose.** Auth.js picks the `__Secure-` cookie prefix from
   `url.protocol` alone, so an unset `AUTH_URL` behind TLS yields a non-Secure cookie with no
   error — and 08-04 retracts the onboarding precondition on exactly that condition.

## Plan critique

Run 2026-09-15 (pre-mortem + assumption hunting, read-only). Verdict **REWORK**: 5 CRITICAL
findings, all verified against the actual files and all fixed in the plan text before
execution. In short: base64 passwords break the `DATABASE_URL` URI; `RATE_LIMIT_*` never
reached the container; literal `db` port removal had no working replacement; nothing
mechanically proved the Caddy header directive landed; and `AUTH_URL`'s http default
survived the phase. Also fixed: verification commands that could never match their own
prescribed implementation, greps already satisfied at HEAD, and scope checks that could not
see new files and exited 0 either way.

## Plan structure

| Plan | Wave | Depends on | Files | Agents |
|------|------|-----------|-------|--------|
| 08-01 Proxy migration | 1 | — | `src/proxy.ts` (new), `src/middleware.ts` (del), `src/auth.config.ts` | engineering-backend-architect |
| 08-02 Env-configurable rate limits | 2 | 08-01 | `src/proxy.ts` | engineering-backend-architect, engineering-security-engineer |
| 08-03 Caddy + compose hardening | 2 | — | `Caddyfile` (new), `docker-compose.yml`, `.env.example` | engineering-infrastructure-devops, engineering-security-engineer |
| 08-04 Trust boundary + runbook | 3 | 08-02, 08-03 | `src/proxy.ts`, `DEPLOYMENT.md` | engineering-infrastructure-devops, engineering-security-engineer |

Wave 2's two plans touch disjoint files and run in parallel. `src/proxy.ts` is written by
08-01, 08-02 and 08-04 — never by two plans in the same wave.

**Each wave is committed before the next begins, and wave 2's two plans execute in separate
worktrees.** Without this the scope checks are meaningless: two agents in one tree each see
the other's edits and report SCOPE VIOLATION for work they did not do, and an agent that
"fixes" it by reverting destroys the prior wave. The checks use `git status --porcelain`
(not `git diff`, which cannot see new files like `Caddyfile`) and exit non-zero on a real
violation.

## Explicitly NOT in scope

- Anything in Phase 9 (E2E first real run, ticket-delete guard, QBO item picker)
- Schema changes or migrations — this phase has none
- Merging `auth.config.ts` back into the proxy
- Replacing the in-memory `rateLimitStore` with a shared store (single-instance deployment;
  comment the caveat, do not fix it)
- Automated backups / restore drill (exploration doc "Later")
