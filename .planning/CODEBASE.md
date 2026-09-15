# MSP PSA — Codebase Map

<!-- Legion map metadata. /legion:map --check reads this block. -->
```yaml
map_schema_version: 1
generated_at: 2026-09-15T13:40:54Z
analyzed_commit: b4c6dd2dc582bf31571929aa3b37db1e103a5b85
source_file_count: 143
source_fingerprint: sha256:eb4b427a4248ed58c53100aa3cf0a648cb84a5c29ac0b8bf6e15efe2a22f6b7b
fingerprint_method: "git ls-tree -r origin/master <src globs> | path + byte size | sort | sha256sum"
scope: full-project
```

## Architecture Narrative

A single Next.js 16 App Router application backed by PostgreSQL, plus two standalone
Node entry points (an email worker and an admin-bootstrap CLI). There is no separate API
service — the browser talks to React Server Components and Server Actions, and those talk
to Prisma directly. Roughly 18,000 lines of TypeScript across 143 source files.

Four layers, dependency direction strictly one-way:

```
src/app/**            routes, layouts, pages          (App Router)
   |  imports
src/components/**     presentational + form components
   |  imports
src/lib/actions/**    Server Actions — the write boundary
   |  imports
src/lib/**            pure domain logic + data access
   |
prisma/               schema, 10 migrations, seed
```

Nothing in `src/lib/` imports from `src/app/` or `src/components/`. Domain modules
(`billing.ts`, `sla.ts`, `timer.ts`) are pure functions with no Prisma import.

**The authorization choke point.** Every protected surface funnels through
`src/lib/session.ts`, which exports three gates:

| Gate | Use | On failure |
|------|-----|-----------|
| `getCurrentUser()` | Resolve caller, no redirect | returns `null` |
| `requireActiveUser()` | Session-only pages (no role rule) | → `/login`, or `/change-password` |
| `requireRole(roles)` | Role-restricted pages and every Server Action | → `/unauthorized`, or `/change-password` |

**The database is authoritative, not the JWT.** This is the single biggest change in the
codebase and it inverts the previous design. `getCurrentUser()` decodes the session cookie
only to obtain an `id`, then reads the live `User` row for `role`, `isActive`,
`mustChangePassword` and `tokenVersion`. Deactivation and role changes therefore take
effect on the *next request* rather than at the end of the 8-hour `maxAge`. Both the token
read and the row read are wrapped in React `cache()` — request-scoped dedupe, not a TTL —
so a dashboard render pays for one query, not three.

**Revocation via `tokenVersion`.** Re-reading role/isActive is not sufficient, because
neither changes when a password is rotated. Every JWT is stamped at mint time with the
`tokenVersion` current then; `getCurrentUser()` compares it to the live column and refuses
any mismatch. Any write that increments the column invalidates every token issued before
it. Two properties are load-bearing and easy to break:

- The claim is **stamped once and never refreshed** (`src/auth.ts` jwt callback). Re-reading
  it there would let a revoked token silently self-heal.
- The claim is read from the **raw JWT**, never from `Session`, and is deliberately absent
  from the `Session` type augmentation — anything on `Session` is served to any client by
  `GET /api/auth/session`, which is exempt from the middleware gate.

A token carrying *no* `tokenVersion` claim is refused, not defaulted to 0. `getCurrentUser()`
also **fails closed**: a throwing lookup is not caught, so a database outage or an unapplied
migration surfaces as an error rather than as a silent app-wide logout.

**Two runtimes, one boundary.** `src/auth.config.ts` is Edge-safe (no adapter, no bcrypt,
no Prisma) and is consumed by `src/middleware.ts`. `src/auth.ts` is the Node-runtime module
adding the Credentials provider and JWT callbacks. Middleware performs only a coarse
"is there a session cookie" check plus rate limiting; the authoritative role gate is always
server-side. `src/lib/session.ts` is strictly Node-runtime — never import it from middleware.

The three highest fan-in modules are `db` (33 importers), `session` (32) and `permissions`
(30); a change to any of them touches most of the app.

## Module Structure & Ownership

| Path | Responsibility | Notes |
|------|----------------|-------|
| `src/app/(auth)/` | Login, change-password | Layout does **no** session check — by design, so `/change-password` cannot redirect-loop |
| `src/app/(dashboard)/` | All authenticated UI | Layout calls the session gate and redirects; 15 routes |
| `src/app/api/` | 3 route handlers | NextAuth catch-all + QBO OAuth connect/callback |
| `src/components/ui/` | shadcn/ui primitives (13) | Generated; avoid hand-editing |
| `src/components/admin/` | User create form, row actions | Phase 7 |
| `src/components/{crm,tickets,invoices,reports,nav}/` | Feature components | Some are async Server Components (`*-tab.tsx`) |
| `src/lib/actions/` | 11 Server Action modules | The only write path; each re-checks roles |
| `src/lib/validations/` | 9 zod schemas | `contract.ts` is a discriminated union |
| `src/lib/` (root) | Domain + infra | `billing`, `sla`, `timer`, `reporting`, `permissions`, `crypto`, `qbo`, `db`, `session`, `bootstrap-admin` |
| `prisma/` | Schema (350 lines), 10 migrations, seed | Seed creates the five role accounts |
| `scripts/email-poller.ts` | Standalone worker | Email-to-ticket + SLA breach sweep |
| `scripts/create-admin.ts` | Bootstrap CLI (`npm run bootstrap:admin`) | Creates/resets the first admin outside the app |
| `e2e/` | 7 Playwright specs + 7 support modules | Three projects; see Test Map |

## Data Model

17 models and enums in `prisma/schema.prisma` (350 lines).

- **Identity**: `User`, `Role` enum (`technician | dispatcher | sales | finance | admin`)
- **User lifecycle fields** (Phase 7): `isActive`, `mustChangePassword`, `tokenVersion`
- **Auth.js scaffolding**: `Account`, `Session`, `VerificationToken` — present but
  **unused**, because the app runs a JWT session strategy with a Credentials-only provider
- **CRM**: `Company` → `Site`, `Contact`, `Contract`, `Asset` (all `onDelete: Cascade`)
- **Service desk**: `Ticket`, `TicketComment`, plus status/priority/source enums
- **Billing**: `TimeEntry`, `Invoice`, `InvoiceLineItem`, `InvoiceStatus`, `BillingType`
- **Integration**: `QuickBooksConnection` (OAuth tokens, encrypted at rest)

Cascade behaviour worth knowing before touching deletes: `Ticket` deletion cascades to
**both** `TicketComment` *and* `TimeEntry`, while `TimeEntry.invoiceLineItem` is `SetNull`.
Deleting a ticket therefore destroys time records while leaving the invoice line item that
billed them.

## Route & API Surface

**Pages**

| Route | Group | Gate |
|-------|-------|------|
| `/login`, `/change-password` | `(auth)` | none at layout level |
| `/` | `(dashboard)` | session |
| `/clients`, `/clients/new`, `/clients/[companyId]` | `(dashboard)` | session / role |
| `/tickets`, `/tickets/new`, `/tickets/[ticketId]` | `(dashboard)` | session / role |
| `/invoices`, `/invoices/[invoiceId]` | `(dashboard)` | session / role |
| `/reports/utilization`, `/reports/sla`, `/reports/profitability` | `(dashboard)` | `REPORT_VIEW_ALL_ROLES` |
| `/admin/users` | `(dashboard)` | `requireRole(ADMIN_MANAGE_ROLES)` |
| `/admin/quickbooks` | `(dashboard)` | open-coded `getCurrentUser()` + `can()` — predates the convention |
| `/unauthorized` | `(dashboard)` | — |

**Route handlers**: `GET|POST /api/auth/[...nextauth]`, `GET /api/qbo/connect`,
`GET /api/qbo/callback`.

**Server Actions** are the real mutation API — 40 exported actions across 13 modules.
Notable: `users.ts` (5), `tickets.ts` (5), `time-entries.ts` (4), `invoices.ts` (3).

## Configuration & Environment

| Variable | Consumed by | Required |
|----------|-------------|----------|
| `DATABASE_URL` | `src/lib/db.ts`, worker, bootstrap CLI | Yes |
| `AUTH_SECRET` | Auth.js, `src/lib/session.ts` | Yes |
| `AUTH_SECRET_1..3` | `src/lib/session.ts` rotation slots | No (rotation) |
| `AUTH_URL`, `AUTH_TRUST_HOST` | Auth.js | Deployment |
| `TOKEN_ENCRYPTION_KEY` | `src/lib/crypto.ts` | Yes (QBO) |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, `QBO_ENVIRONMENT` | `src/lib/qbo.ts` | QBO only |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `MAILBOX_ADDRESS` | `scripts/email-poller.ts` (fails fast) | Poller only |
| `ALLOW_SEED_IN_PRODUCTION` | `prisma/seed.ts` | Escape hatch |
| `E2E_BASE_URL`, `E2E_PORT` | `e2e/target.ts` | E2E only |
| `DB_PORT`, `NODE_ENV`, `CI` | Compose / tooling | No |

`docker-compose.yml` runs three services — `app`, `email-poller`, `db` (postgres:16-alpine).

## Test & Coverage Map

Playwright now defines **three projects**, and the distinction is load-bearing:

| Project | Specs | Role |
|---------|-------|------|
| `lifecycle` | `user-lifecycle`, `bootstrap-admin`, `harness` | **Blocking gate.** `npm run test:e2e` runs this |
| `last-active-admin` | `last-active-admin` | Runs *after* `lifecycle` (`dependencies`), `fullyParallel: false` — its precondition is that the seeded admin is the only active admin |
| `advisory` | `tickets`, `sla-tracking`, `time-entry-to-invoice` | The three pre-Phase-7 specs. **Never run against a browser**; block nothing |

`globalSetup`/`globalTeardown` hooks exist, and `reuseExistingServer: false` is
unconditional — a run starts its own server or fails, so it can never silently grade a
stale container. Specs still target the **dev database**; there is no separate test-database
strategy.

Unit coverage remains a single file: `src/lib/__regression__/reporting.regression.test.ts`.

## Risk Hotspots

1. **`X-Forwarded-For` is still attacker-controlled.** `getClientIp()` trusts a
   client-settable header and `docker-compose.yml` publishes `app` on `3000` with no
   reverse proxy, so the rate limiter is a no-op against a deliberate attacker. Partially
   hardened: an unidentifiable client now returns `null` and is skipped rather than sharing
   one bucket (which had produced a measured DoS). ROADMAP Phase 8 owns the real fix.
2. **`src/middleware.ts` uses a convention Next.js 16 deprecated.** `middleware.js` is
   renamed to `proxy.js`; Proxy runs on the Node runtime and cannot be configured back to
   Edge. Codemod: `npx @next/codemod@canary middleware-to-proxy .`
3. **Default database credentials.** `postgres:postgres` is inline in `POSTGRES_PASSWORD`
   *and* both `DATABASE_URL`s, with `${DB_PORT:-5432}` published to the host.
4. **Ticket delete destroys billing records** (see Data Model). `deleteTicket` still has
   zero call sites in `src/`.
5. **`ItemRef` hardcoded** to `{ value: "1" }` in `invoices.ts` — every QBO invoice line
   points at the same item.
6. **Three E2E specs have never run.** The `advisory` project is evidence, not a gate;
   ROADMAP Phase 9 owns their first real run.
7. **Unused Auth.js tables.** `Account` / `Session` / `VerificationToken` cannot be
   populated under JWT + Credentials. Harmless, but misleading when reading the schema for
   the session model.
8. **`/admin/quickbooks` predates the gating convention** — it open-codes
   `getCurrentUser()` + `can()` + manual redirects instead of `requireRole()`. Use it as a
   layout model only, never as a gating model.

## Setup / Runbook

```bash
npm install
npx prisma generate            # required on the host after checkout
docker compose up -d db
npm run db:migrate             # prisma migrate dev
npm run db:seed                # five role accounts
npm run bootstrap:admin        # or create/reset the first admin directly
npm run dev                    # http://localhost:3000
```

Other entry points: `npm run build`, `npm run lint`, `npm run test:e2e` (gate),
`npm run test:e2e:advisory`, `npm run test:e2e:all`, `npm run email-poller`,
`npm run db:migrate:deploy` (runs `scripts/post-migrate.sh`). `DEPLOYMENT.md` documents the
self-hosted Docker path.

## Patterns & Conventions

- **Server Action shape**: `"use server"`, `requireRole(X_ROLES)` first, zod parse second,
  Prisma write third, then `revalidatePath()` and often `redirect()`. Errors come back as
  `{ error: string }` rather than thrown.
- **Page gating**: `requireActiveUser()` for session-only pages, `requireRole()` when a role
  rule applies. Do not open-code `getCurrentUser()` + `redirect()` in a page.
- **Role constants over literals**: `CRM_MANAGE_ROLES`, `TICKET_MANAGE_ROLES`,
  `ADMIN_MANAGE_ROLES` etc. from `permissions.ts`.
- **`redirect()` inside try/catch** needs `isNextRedirectError()` (12 importers) because
  Next signals redirects by throwing.
- **Validation lives in `src/lib/validations/`**, never inline in the action.
- **Path alias** `@/*` → `src/*`.
- **Pure domain modules** (`billing`, `sla`, `timer`) take plain inputs and return plain
  results — keep Prisma out of them.
- **Serialized invariants**: code paths that could reduce the number of active admins take
  the same Postgres advisory lock (`ADMIN_INVARIANT_LOCK_KEY`). Any new such path must take
  it too or it is not serialized.

## Not a Monorepo

Single `package.json` at the root; no workspaces.
