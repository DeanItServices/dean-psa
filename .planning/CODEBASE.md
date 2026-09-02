# MSP PSA — Codebase Map

<!-- Legion map metadata. /legion:map --check reads this block. -->
```yaml
map_schema_version: 1
generated_at: 2026-09-02
analyzed_commit: f2e1113cc08bb0485148484c2eec98b1f5a9a6e5
source_file_count: 120
source_fingerprint: sha256:85970fa39e2124f75701f8b0e74ea45f2202d7a3070634de579f360a6f91fdc5
fingerprint_method: "find <src globs> -printf '%P %s' | sort | sha256sum"
scope: full-project
```

## Architecture Narrative

A single Next.js 16 App Router application backed by PostgreSQL, plus one standalone
background worker. There is no separate API service — the browser talks to React Server
Components and Server Actions, and those talk to Prisma directly. Roughly 11,000 lines of
TypeScript across 120 source files.

The codebase is organized in four layers, and the dependency direction is strictly one-way:

```
src/app/**            routes, layouts, pages          (App Router)
   |  imports
src/components/**     presentational + form components
   |  imports
src/lib/actions/**    Server Actions — the write boundary
   |  imports
src/lib/**            pure domain logic + data access
   |
prisma/               schema, migrations, seed
```

Nothing in `src/lib/` imports from `src/app/` or `src/components/`. Domain modules
(`billing.ts`, `sla.ts`, `timer.ts`) are pure functions with no Prisma import at all,
which is why they are the only parts of the system with direct unit-test coverage
(`src/lib/__regression__/reporting.regression.test.ts`).

**The authorization choke point.** Every protected surface funnels through
`getCurrentUser()` / `requireRole()` in `src/lib/session.ts`. `requireRole()` delegates
entirely to `getCurrentUser()`, which today reads only the JWT and performs **zero
database queries**. Combined with `src/lib/permissions.ts` (a `can(role, permission)`
matrix plus named `*_ROLES` constants), this is the whole authorization story. The three
highest fan-in modules in the codebase are exactly `db` (28 importers), `permissions`
(27), and `session` (25) — a change to any of them touches most of the app.

**Two runtimes, one boundary.** `src/auth.config.ts` is deliberately Edge-safe (no
adapter, no bcrypt, no Prisma) and is consumed by `src/middleware.ts`. `src/auth.ts` is
the Node-runtime module that adds the Credentials provider and JWT callbacks. Middleware
performs only a coarse "is there a session cookie" check; the authoritative role gate is
always server-side.

## Module Structure & Ownership

| Path | Responsibility | Notes |
|------|----------------|-------|
| `src/app/(auth)/` | Login surface | Layout does **no** session check — a plain centered card |
| `src/app/(dashboard)/` | All authenticated UI | Layout calls `getCurrentUser()`, redirects to `/login` |
| `src/app/api/` | 3 route handlers | NextAuth catch-all + QBO OAuth connect/callback |
| `src/components/ui/` | shadcn/ui primitives (12) | Generated; avoid hand-editing |
| `src/components/{crm,tickets,invoices,reports,nav}/` | Feature components | Some are async Server Components (`*-tab.tsx`) |
| `src/lib/actions/` | 10 Server Action modules | The only write path; each re-checks roles |
| `src/lib/validations/` | 8 zod schemas | Input parsing; `contract.ts` is a discriminated union |
| `src/lib/` (root) | Domain + infra | `billing`, `sla`, `timer`, `reporting`, `permissions`, `crypto`, `qbo`, `db`, `session` |
| `prisma/` | Schema, 8 migrations, seed | Seed is the only user-creation path in the tree |
| `scripts/email-poller.ts` | Standalone worker (457 lines) | Email-to-ticket + SLA breach sweep |
| `e2e/` | 3 Playwright specs + fixtures | Never executed against a real browser |

## Data Model

17 models and enums in `prisma/schema.prisma` (341 lines).

- **Identity**: `User`, `Role` enum (`technician | dispatcher | sales | finance | admin`)
- **Auth.js scaffolding**: `Account`, `Session`, `VerificationToken` — present but
  **unused**, because the app runs a JWT session strategy with a Credentials-only
  provider list. See Risks.
- **CRM**: `Company` → `Site`, `Contact`, `Contract`, `Asset` (all `onDelete: Cascade`
  from `Company`)
- **Service desk**: `Ticket`, `TicketComment`, plus `TicketStatus` / `TicketPriority` /
  `TicketSource` enums
- **Billing**: `TimeEntry`, `Invoice`, `InvoiceLineItem`, `InvoiceStatus`, `BillingType`
- **Integration**: `QuickBooksConnection` (OAuth tokens, encrypted at rest)

Cascade behaviour worth knowing before touching deletes: `Ticket` deletion cascades to
**both** `TicketComment` *and* `TimeEntry` (`schema.prisma:265`), while
`TimeEntry.invoiceLineItem` is `SetNull` (`:280`). Deleting a ticket therefore destroys
time records while leaving the invoice line item that billed them.

## Route & API Surface

**Pages** (`(dashboard)` unless noted)

| Route | File |
|-------|------|
| `/login` | `src/app/(auth)/login/page.tsx` |
| `/` | `src/app/(dashboard)/page.tsx` |
| `/clients`, `/clients/new`, `/clients/[companyId]` | `src/app/(dashboard)/clients/` |
| `/tickets`, `/tickets/new`, `/tickets/[ticketId]` | `src/app/(dashboard)/tickets/` |
| `/invoices`, `/invoices/[invoiceId]` | `src/app/(dashboard)/invoices/` |
| `/reports/utilization`, `/reports/sla`, `/reports/profitability` | `src/app/(dashboard)/reports/` |
| `/admin/quickbooks` | `src/app/(dashboard)/admin/quickbooks/page.tsx` |
| `/unauthorized` | `src/app/(dashboard)/unauthorized/page.tsx` |

`(dashboard)` also has shared `loading.tsx` and `error.tsx` covering all 13 routes.

**Route handlers**: `GET|POST /api/auth/[...nextauth]`, `GET /api/qbo/connect`,
`GET /api/qbo/callback`.

**Server Actions** are the real mutation API — 34 exported actions across
`src/lib/actions/`. Notable: `tickets.ts` (5), `time-entries.ts` (4), `invoices.ts` (3,
including `pushInvoiceToQbo`), and full CRUD in each CRM module.

## Configuration & Environment

| Variable | Consumed by | Required |
|----------|-------------|----------|
| `DATABASE_URL` | `src/lib/db.ts`, worker | Yes |
| `AUTH_SECRET`, `AUTH_URL`, `AUTH_TRUST_HOST` | Auth.js (implicit) | Yes |
| `TOKEN_ENCRYPTION_KEY` | `src/lib/crypto.ts` | Yes (QBO) |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, `QBO_ENVIRONMENT` | `src/lib/qbo.ts` | QBO only |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `MAILBOX_ADDRESS` | `scripts/email-poller.ts` (fails fast) | Poller only |
| `ALLOW_SEED_IN_PRODUCTION` | `prisma/seed.ts` | Escape hatch |
| `DB_PORT`, `NODE_ENV`, `CI` | Compose / tooling | No |

`docker-compose.yml` runs three services — `app`, `email-poller`, `db` (postgres:16-alpine).

## Test & Coverage Map

| Kind | Location | State |
|------|----------|-------|
| Regression unit tests | `src/lib/__regression__/reporting.regression.test.ts` (263 lines) | Only direct test coverage |
| E2E | `e2e/tickets.spec.ts`, `time-entry-to-invoice.spec.ts`, `sla-tracking.spec.ts` | **Never run against a browser** |
| Fixtures | `e2e/fixtures.ts` — `loginAs`, `ROLE_CREDENTIALS` | Shared across all 3 specs |

`playwright.config.ts` uses `fullyParallel: true` and boots `npm run dev` against the
**dev database** — there is no separate test-database strategy. Two cases in
`tickets.spec.ts:231` are `test.fixme` because no delete UI exists to drive.

## Risk Hotspots

1. **`src/middleware.ts` uses a convention Next.js 16 deprecated.** `middleware.js` is
   renamed to `proxy.js`; Proxy runs on the Node runtime, which cannot be configured back
   to Edge. All the Edge-safety commentary in this file and in `auth.config.ts` is
   becoming historical. Codemod: `npx @next/codemod@canary middleware-to-proxy .`
2. **`X-Forwarded-For` is attacker-controlled.** `getClientIp()` (`middleware.ts:134`)
   trusts a client-settable header, and `docker-compose.yml` publishes `app` on `3000`
   with no reverse proxy. The IP rate limiter — including `/api/auth/*` brute-force
   protection — is a no-op against a deliberate attacker in the shipped topology. The
   file says so at length and correctly notes only infrastructure can fix it.
3. **Default database credentials.** `postgres:postgres` is inline in `db.POSTGRES_PASSWORD`
   *and* both `app` and `email-poller` `DATABASE_URL`s, with `${DB_PORT:-5432}` published
   to the host.
4. **No user-management UI.** Zero `user.create` call sites outside `prisma/seed.ts`. The
   `admin:manage_users` permission exists (`permissions.ts:10`) and already gates the
   sidebar Admin section, but nothing hangs off it besides `/admin/quickbooks`.
5. **Ticket delete destroys billing records** (see Data Model). `deleteTicket`
   (`tickets.ts:237`) also has zero call sites in `src/`.
6. **`ItemRef` hardcoded** to `{ value: "1" }` in `invoices.ts:367` — every QBO invoice
   line points at the same item.
7. **Session staleness.** The JWT carries `role`, and `getCurrentUser()` never re-reads
   the database, so a role change or a deactivation is invisible for up to the 8-hour
   `maxAge`.
8. **Unused Auth.js tables.** `Account` / `Session` / `VerificationToken` exist in the
   schema but cannot be populated under the JWT + Credentials configuration. Harmless,
   but misleading to anyone reading the schema for the session model.

## Setup / Runbook

```bash
npm install
npx prisma generate            # required on the host after checkout
docker compose up -d db
npm run db:migrate             # prisma migrate dev
npm run db:seed                # only path to a usable account today
npm run dev                    # http://localhost:3000
```

Other entry points: `npm run build`, `npm run lint`, `npm run test:e2e`,
`npm run email-poller`, `npm run db:migrate:deploy` (runs `scripts/post-migrate.sh`).
`DEPLOYMENT.md` documents the self-hosted Docker path.

## Patterns & Conventions

- **Server Action shape**: `"use server"`, `requireRole(X_MANAGE_ROLES)` first, zod parse
  second, Prisma write third, then `revalidatePath()` and often `redirect()`. Errors come
  back as `{ error: string }` rather than thrown.
- **Role constants over literals**: use `CRM_MANAGE_ROLES`, `TICKET_MANAGE_ROLES`,
  `INVOICE_MANAGE_ROLES` etc. from `permissions.ts` — inline role arrays are the
  exception, not the norm.
- **`redirect()` inside try/catch** needs `isNextRedirectError()` (`src/lib/is-next-redirect-error.ts`,
  10 importers) because Next signals redirects by throwing.
- **Validation lives in `src/lib/validations/`**, never inline in the action.
- **Path alias** `@/*` → `src/*`.
- **Pure domain modules** (`billing`, `sla`, `timer`) take plain inputs and return plain
  results — keep Prisma out of them.

## Not a Monorepo

Single `package.json` at the root; no workspaces.
