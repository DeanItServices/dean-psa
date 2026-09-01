# Phase 6: Polish & Launch Prep -- Context

## Phase Goal
Harden the application for real daily use -- performance, UX consistency, and self-hosted deployment readiness. Unlike Phases 1-5, this phase adds no new product requirements; it hardens what Phases 1-5 already built.

## Requirements Covered
No `.planning/REQUIREMENTS.md` exists (pre-milestone-requirements-doc project, same as Phases 3-5). This phase relies on ROADMAP.md's five Phase 6 success criteria plus a concrete scope negotiated with the user during planning (see "Locked Scope Decisions" below):
- UI is consistent and responsive across all modules
- Docker-based deployment is documented and reproducible
- Core workflows pass end-to-end verification
- No critical or high-severity issues open from QA review
- **CRITICAL (carried forward from Phase 4 review, user-escalated)**: QuickBooksConnection's OAuth tokens are encrypted at the application layer before being written to the database

## What Already Exists (from prior phases)

**Stack** (unchanged): Next.js 16 (App Router) + TypeScript, Tailwind CSS v4 + shadcn/ui, PostgreSQL via Prisma 7 (`@prisma/adapter-pg`), Docker Compose (`app` + `email-poller` + `db` services), Auth.js v5 with JWT sessions (8hr maxAge), `src/middleware.ts` (Edge-safe coarse auth check via `authConfig`, matcher excludes `login`/`api/auth`/`_next/static`/`_next/image`/`favicon.ico`).

**QBO integration** (`src/lib/qbo.ts`, verified read in full during planning): `exchangeCodeForTokens`, `refreshAccessToken`, `getValidQboClient()`, `buildAuthorizeUrl`. `getValidQboClient()` (lines 146-177) is the single choke point for all token reads/writes -- it reads `connection.accessToken`/`connection.refreshToken` (line 157, 161) and writes new tokens via `db.quickBooksConnection.update()` (lines 163-170). `QuickBooksConnection` model (`prisma/schema.prisma` lines 324-334): `accessToken String @db.Text`, `refreshToken String @db.Text`, both currently plaintext.

**Ticket RBAC** (`src/lib/actions/tickets.ts`, verified read in full): `deleteTicket` (lines 228-242) gates only on `requireRole(TICKET_MANAGE_ROLES)` (technician, dispatcher, admin) with no ownership check -- any technician can delete any ticket, not just their own. `TICKET_MANAGE_ROLES`/`TICKET_ASSIGN_ROLES` are exported from `src/lib/permissions.ts`.

**Permissions matrix** (`src/lib/permissions.ts`, read in full): centralized `Permission` union + `ROLE_PERMISSIONS: Record<Role, Permission[]>` + `can(role, permission): boolean` (fail-secure) + per-domain `Role[]` shared constants (`CRM_MANAGE_ROLES`, `TICKET_MANAGE_ROLES`, `TICKET_ASSIGN_ROLES`, `TIME_ENTRY_MANAGE_ROLES`, `INVOICE_MANAGE_ROLES`, `QBO_MANAGE_ROLES`, `REPORT_VIEW_ALL_ROLES`). This phase's ownership-scoped delete does NOT need a new `Permission` literal -- ownership is an in-code check on top of the existing `ticket:manage` permission, not a new authorization dimension (see Plan 06-02).

**Kanban board** (`src/components/tickets/kanban-board.tsx`, read in full): `"use client"`, `@dnd-kit/core` `DndContext` with `PointerSensor` + `KeyboardSensor`, 5 fixed status columns (`STATUS_COLUMNS`, lines 26-32), optimistic `items` state with an `isMutatingRef`/`pendingTicketsRef` pair guarding against prop-sync races (Phase 3 review fix). No responsive breakpoint exists today -- confirmed desktop-first by apparent design, not a documented product decision.

**SlaBadge** (`src/components/tickets/sla-badge.tsx`, read in full): the SOLE shared SLA-status rendering implementation (Kanban card + ticket detail page both import it). `STATUS_CLASS` (lines 36-42) hardcodes Tailwind colors (`bg-green-600`, `bg-yellow-500`) instead of theme tokens -- no dark-mode adaptation.

**Route structure**: all 13 authenticated pages live under `src/app/(dashboard)/` (one route group), wrapped by `src/app/(dashboard)/layout.tsx` (async Server Component, `getCurrentUser()` + redirect-if-null defense-in-depth alongside middleware). Confirmed via Glob during planning: **no `loading.tsx` or `error.tsx` exists anywhere in the project** -- a DB/query failure on any dashboard page currently surfaces Next.js's generic, unstyled error screen.

**API routes**: `src/app/api/auth/[...nextauth]/route.ts`, `src/app/api/qbo/callback/route.ts`, `src/app/api/qbo/connect/route.ts`. No rate limiting exists on any of these today (Phase 1 review deferred suggestion).

**Test infrastructure**: confirmed via Glob during planning -- exactly one test file exists project-wide, `src/lib/__regression__/reporting.regression.test.ts` (24 unit tests using Node's built-in `--experimental-strip-types --test` runner, no framework installed). No E2E framework, no `test` script in `package.json`.

**Docker/deployment**: `docker-compose.yml` (3 services: `app`, `email-poller`, `db`), `Dockerfile` (3-stage: deps/builder/runner, `node:20.20-alpine`), `.env.example` (documents `DB_PORT` per-worktree convention, `DATABASE_URL`, `AUTH_SECRET`/`AUTH_URL`/`AUTH_TRUST_HOST`, Microsoft Graph vars, QBO vars). `package.json` scripts: `db:migrate:deploy` runs `prisma migrate deploy && bash scripts/post-migrate.sh` (the script that idempotently applies the Phase 4 raw-SQL partial index). No standalone deployment runbook/README section exists yet describing the end-to-end reproduction steps for a fresh MSP-owned host.

**Schema gaps** (from accumulated review suggestions, confirmed via schema read): `Invoice.qboInvoiceId` (line 297, `String?`) has no unique index -- the atomic `"PENDING"` claim mechanism (Phase 4) is the primary duplicate-push guard, this would be defense-in-depth only. `Contact`/`Contract`/`Asset` (`companyId String`, lines 115-159) have no `@@index([companyId])` despite being FK-filtered in CRM tab queries.

## Key Design Decisions

**Architecture approach**: Skipped by user choice during planning (no competing proposals generated). Rationale accepted: this phase fixes/hardens already-built, already-reviewed code per a well-defined punch list; the "right approach" for each item is dictated by existing codebase patterns (the same shared-constant RBAC pattern, the same Prisma `@@index` pattern, the same `src/lib/{name}.ts` module convention), not open architectural choice.

**Spec pipeline**: Skipped by user choice -- scope was already concretely specified via the locked CRITICAL plus a scope-negotiation AskUserQuestion pass (see below).

**Locked Scope Decisions (user-selected during planning, 2026-09-01)**:
This phase does NOT attempt every deferred suggestion accumulated across Phases 1-5's reviews (there are ~20 of them; attempting all would balloon scope past what "polish and launch prep" should be). The user was presented with the full deferred-suggestions inventory and explicitly selected the following as in-scope for Phase 6; everything not listed here remains accepted, non-blocking debt for a future milestone:
- **QBO token encryption** (locked CRITICAL, not optional) -- Plan 06-01.
- **Blanket `ticket:manage` delete / ownership scoping** (selected) -- Plan 06-02.
- **Rate limiting before internet exposure** (selected, relevant now since this phase is explicitly "launch prep" for a self-hosted, internet-reachable app) -- Plan 06-02.
- **Missing DB indexes** (`Invoice.qboInvoiceId` unique index + CRM FK `@@index`) (selected) -- Plan 06-03.
- **`loading.tsx`/`error.tsx` for route groups** (selected, directly matches the "UI is consistent and responsive" criterion) -- Plan 06-05.
- **Kanban board responsive breakpoint** (selected) -- Plan 06-05.
- **`SlaBadge` dark-mode/theme tokens** (selected) -- Plan 06-05.
- **E2E verification strategy**: user selected **Playwright + automated E2E specs** over a manual checklist, despite zero E2E infrastructure existing today -- this is a deliberate scope addition (new dependency + CI-adjacent tooling), not a minimal-footprint choice. Plans 06-04 (infra) + 06-06/06-07/06-08 (specs).

**Explicitly NOT in scope for Phase 6** (deferred, not fixed, from the accumulated suggestions list -- do not re-open during execution):
- `resolveActiveContract` query-logic duplication between `tickets.ts`/`invoices.ts` (accepted since Phase 3).
- Redundant/dead nested permission check on the sidebar's Admin nav item.
- `realmId` from the OAuth callback not format-validated before URL interpolation.
- Lifetime prior-invoiced aggregate omits an explicit (currently redundant) `isBillable: true` filter.
- A block-hour contract with in-block usage but zero overage still generates a $0.00 invoice (needs product confirmation, not a code fix).
- `getClientProfitability`'s `contractId` join-path coupling documentation.
- `server-only` import guard on `reporting.ts`/`db.ts`.
- Contract-filter "active" label edge case for stale/deleted contracts.
- Missing `.gitignore` entry for the email-poller's watermark file.
- Non-deterministic sender-to-Contact email matching across companies.
- Whole-card Kanban drag handle / nested subject-link focus overlap.
- Dead/unreachable ticket-edit code path.
- Dispatcher's inclusion in `report:view_all` (product judgment call, not a bug).

**QBO Token Encryption approach (locked)**: AES-256-GCM via Node's built-in `crypto` module (no new dependency). A single new module `src/lib/crypto.ts` exports `encrypt(plaintext: string): string` and `decrypt(ciphertext: string): string`, keyed by a new required env var `TOKEN_ENCRYPTION_KEY` (32-byte key, base64-encoded). `src/lib/qbo.ts` is the ONLY call site that touches `QuickBooksConnection.accessToken`/`refreshToken` (confirmed via full-file read during planning) -- encryption/decryption is applied at the three points tokens cross the DB boundary: `getValidQboClient()`'s initial read (line 157), `getValidQboClient()`'s refreshed-token write (lines 163-170) and subsequent return (line 172), and nowhere else needs modification. This is an application-layer encryption approach (not `pgcrypto` or a DB-level extension) per the original Phase 4 review's recommendation and the project's "optimize for simplicity" constraint.

**Rate limiting approach (locked, CORRECTED after plan critique)**: applied inside `src/middleware.ts` (Edge-safe) using an in-memory token-bucket keyed by IP address -- no new dependency, no Redis, appropriate for a self-hosted single-instance deployment sized for <25 users. This is explicitly a basic DoS/brute-force speed bump, not a distributed rate-limiter; the plan must document this limitation, not oversell it.

**CRITICAL CORRECTION (plan critique, both pre-mortem and assumption-hunting independently caught this): `src/middleware.ts`'s actual current matcher -- `["/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)"]` -- explicitly EXCLUDES `/api/auth/*` from middleware entirely.** An earlier draft of this document incorrectly asserted middleware "already runs before every matched route including `/api/auth/[...nextauth]`" -- that was false and has been removed. `/api/auth/[...nextauth]` (NextAuth's own credential-check/login endpoint -- precisely the brute-force surface a rate limiter is meant to protect) is NOT covered by the current matcher and would NOT be rate-limited by a naive implementation that only adds logic inside the existing middleware function. Plan 06-02 MUST achieve real coverage of `/api/auth/*`, not just document the gap as accepted -- see 06-02-PLAN.md's corrected implementation sequence for the exact mechanism (widen the middleware matcher to include `api/auth` while preserving NextAuth's own internal session/CSRF endpoints' functionality, OR add an equivalent rate-limit check inside/ahead of the NextAuth route handler itself). `/api/qbo/callback` and `/api/qbo/connect` ARE covered by the existing matcher (they are not in the exclusion list) and require no special handling.

**Ownership-scoped delete approach (locked)**: `deleteTicket` gains an ownership check -- a `technician`-role user may only delete a ticket where `ticket.assignedToId === user.id`; `dispatcher` and `admin` retain the existing unrestricted delete (matching their broader triage/administrative role). This does NOT require a new `Permission` literal in `permissions.ts` -- it is an in-function ownership check layered on top of the existing `ticket:manage` gate, following the same pattern as `TimeEntry`'s per-user scoping elsewhere in the codebase.

**Playwright E2E approach (locked)**: `@playwright/test` installed as a devDependency, config at `playwright.config.ts` (repo root), specs under `e2e/*.spec.ts` (new top-level directory, sibling to `src/`, matching Playwright's own convention -- NOT inside `src/` since these are not application source). Tests run against a locally-started `npm run dev` server (Playwright's `webServer` config option) against the local dev database -- no separate test-database strategy is introduced in this phase (that would be a larger scope addition; explicitly deferred). A `package.json` `"test:e2e": "playwright test"` script is added.

## Plan Structure

### Wave 1 (no dependencies)
- **Plan 06-01**: QBO Token Encryption (CRITICAL) -- `src/lib/crypto.ts` (new AES-256-GCM helper) + wire encrypt/decrypt into `src/lib/qbo.ts`'s three DB-boundary call sites + `.env.example` documentation for `TOKEN_ENCRYPTION_KEY`.
- **Plan 06-02**: RBAC Hardening -- ownership-scoped `deleteTicket` + IP-keyed rate limiting in `src/middleware.ts`.
- **Plan 06-03**: Database Indexes -- `Invoice.qboInvoiceId` unique index + `@@index([companyId])` on `Contact`/`Contract`/`Asset`, via one migration.
- **Plan 06-04**: Playwright E2E Infrastructure -- installs `@playwright/test`, `playwright.config.ts`, `e2e/` directory scaffold, a shared login/seed-data fixture helper that Wave 2's 3 spec plans will import.

### Wave 2 (depends on Wave 1)
- **Plan 06-05**: UI Consistency -- `src/app/(dashboard)/loading.tsx` + `src/app/(dashboard)/error.tsx` (one pair covers all 13 routes in the group), Kanban board responsive breakpoint, `SlaBadge` theme-token migration.
- **Plan 06-06**: E2E Spec -- Ticket Lifecycle. Depends on 06-04 (fixtures) + 06-02 (tests the new ownership-scoped delete behavior).
- **Plan 06-07**: E2E Spec -- Time Entry to Invoice. Depends on 06-04.
- **Plan 06-08**: E2E Spec -- SLA Tracking. Depends on 06-04.

### Wave 3 (depends on all above)
- **Plan 06-09**: Deployment Documentation -- a new `DEPLOYMENT.md` documenting the full reproducible Docker Compose deployment, including the new `TOKEN_ENCRYPTION_KEY` env var and `test:e2e` script introduced by this phase.

**Wave/dependency clarification**: Wave 1's four plans touch fully disjoint files (`src/lib/crypto.ts`+`src/lib/qbo.ts`+`.env.example` / `src/lib/actions/tickets.ts`+`src/middleware.ts` / `prisma/schema.prisma`+migration / `playwright.config.ts`+`package.json`+`e2e/fixtures.ts`) -- no `sequential_files` guard needed, fully parallel-safe. Wave 2's 06-05 is disjoint from 06-06/07/08 (component/route files vs. `e2e/*.spec.ts` files) -- also fully parallel-safe. 06-06/07/08 each own a distinct spec file under `e2e/` with no shared write target beyond the read-only fixture helper from 06-04.

**Plan critique**: offered to the user after plan file generation (Step 8.5 of the standard planning process) -- see STATE.md for the outcome once run.

**Plan critique outcome (2026-09-01)**: 2 background agents (pre-mortem risk analysis + assumption hunting). 3 CRITICAL findings, all fixed via plan revision before execution: (1) this document previously self-contradicted on whether `/api/auth/*` is covered by rate limiting -- corrected above, and Plan 06-02 now mandates real coverage via a widened matcher rather than accepting the gap; (2) Plan 06-01's decrypt-failure path returned a bare `null` with no operator-visible signal distinguishing "key missing/rotated" from "never connected" -- fixed by requiring a distinguishable `console.error` diagnostic; (3) ROADMAP.md still showed "Phase 6 (2 plans)" after decomposition into 9 -- corrected to 9 in both the phase header and progress table. Also fixed: Plan 06-09's stop-gate now checks each prior plan's SUMMARY `Status:` field (not just file existence) before writing deployment docs, so a Partial/Failed/BLOCKED upstream plan can't produce a false-confidence runbook.
Not fixed, accepted as a Warning-level, non-blocking risk: the E2E test scope (Playwright infra + 3 hand-authored specs against a UI with zero prior E2E coverage) is a larger effort than a typical "polish phase" line item -- this was already an explicit, deliberate user choice during scope negotiation (Playwright over a manual checklist), not an oversight; if Wave 2's spec plans run long or produce brittle results, consider descoping the hardest-to-assert spec (SLA tracking, per 06-08's own scoping note) to a follow-up rather than blocking the rest of the phase on it.
