# MSP PSA — Roadmap

## Phases

- [x] Phase 1: Foundation & Platform Setup (4 plans)
- [x] Phase 2: CRM Core (5 plans)
- [x] Phase 3: Ticketing & Service Desk (4 plans)
- [x] Phase 4: Time Tracking & Billing (6 plans) — Complete
- [x] Phase 5: Reporting & Dashboards (4 plans) — Complete
- [x] Phase 6: Polish & Launch Prep (9 plans) — Complete
- [ ] Phase 7: Account Management & Session Freshness (7 plans)
- [ ] Phase 8: Deployment Hardening (4 plans)
- [ ] Phase 9: Verification & Debt Closure (3 plans)

## Phase Details

### Phase 1: Foundation & Platform Setup
**Goal**: Stand up the application skeleton, database, authentication, and role-based access control that every later module depends on.
**Requirements**: Role-based access control (technician / dispatcher / sales / finance / admin roles)
**Recommended Agents**: engineering-backend-architect, engineering-frontend-developer, security-engineer
**Success Criteria**:
- [ ] Next.js + TypeScript project scaffolded with shadcn/ui + Tailwind configured
- [ ] PostgreSQL schema and migrations running via Docker Compose
- [ ] Login works and enforces role-based permissions across the five roles (technician, dispatcher, sales, finance, admin)
- [ ] Base layout/navigation shell exists for all authenticated roles
**Plans**: 3

### Phase 2: CRM Core
**Goal**: Build the client data model that ticketing, billing, and reporting all depend on — companies, sites, contacts, contracts, and assets.
**Requirements**: Client companies & multi-site records; Contacts per client company; Contracts / service agreements per client; Asset/device tracking tied to clients and tickets
**Recommended Agents**: engineering-backend-architect, engineering-frontend-developer, testing-api-tester
**Success Criteria**:
- [x] Client companies can be created with multiple sites/locations
- [x] Contacts can be added and associated with a client company
- [x] Contracts can be created per client, capturing billing type and SLA targets
- [x] Assets/devices can be recorded and associated with a client
- [x] All CRM records are visible/editable according to role permissions from Phase 1
**Plans**: 5

### Phase 3: Ticketing & Service Desk
**Goal**: Deliver the core day-to-day ticketing workflow — the primary daily-use surface for technicians and dispatch.
**Requirements**: Kanban-style ticket boards/queues for dispatch; Email-to-ticket creation; SLA timers and breach escalation, driven by contract terms
**Recommended Agents**: engineering-frontend-developer, engineering-backend-architect, testing-qa-verification-specialist
**Success Criteria**:
- [x] Tickets can be created manually and via inbound email
- [x] Kanban board shows tickets by status and supports drag-to-reassign/re-status
- [x] Tickets can be assigned to a technician and linked to a client/contact/asset
- [x] SLA timers start on ticket creation, reflect the client's contract terms, and visibly flag approaching/breached SLAs
- [x] Escalation triggers (e.g. notification or flag) fire on SLA breach
**Plans**: 4

### Phase 4: Time Tracking & Billing
**Goal**: Enable technicians to log billable time against tickets and turn that time into accurate invoices per each client's contract terms.
**Requirements**: Timer-based time entry against tickets; Contract-based billing rules; Invoice generation from logged time and contract terms; Accounting integration (QuickBooks or Xero)
**Recommended Agents**: engineering-backend-architect, engineering-frontend-developer, testing-api-tester
**Success Criteria**:
- [x] Technicians can start/stop a timer on a ticket and have it log time automatically
- [x] Time entries are marked billable/non-billable and tied to the ticket's client contract
- [x] Billing rules correctly compute charges for block-hour, flat-fee managed services, and hourly break-fix contract types
- [x] Invoices can be generated from a date range of logged time per client
- [x] Invoices can be pushed to QuickBooks or Xero via API integration
**Plans**: 6

### Phase 5: Reporting & Dashboards
**Goal**: Give managers and leadership visibility into technician workload, SLA health, and client profitability using data already captured by ticketing and billing.
**Requirements**: Technician utilization/workload reporting; SLA compliance reporting; Client profitability reporting
**Recommended Agents**: engineering-backend-architect, engineering-frontend-developer, testing-qa-verification-specialist
**Success Criteria**:
- [x] Dashboard shows technician utilization (time logged vs. capacity) over a selectable date range
- [x] SLA compliance report shows % of tickets meeting response/resolution targets, filterable by client/contract
- [x] Client profitability view compares billed revenue against time invested per client
- [x] Dashboards respect role permissions (e.g. finance/leadership see profitability; technicians see their own utilization)
**Plans**: 4

### Phase 6: Polish & Launch Prep
**Goal**: Harden the application for real daily use — performance, UX consistency, and self-hosted deployment readiness.
**Requirements**: Cross-cutting quality across all v1 modules (no new requirements — hardens Phases 1-5)
**Recommended Agents**: engineering-frontend-developer, testing-qa-verification-specialist, infrastructure-devops-engineer, engineering-security-engineer
**Success Criteria**:
- [x] UI is consistent and responsive across all modules (ticketing, CRM, billing, reporting) — loading/error boundaries, Kanban responsive breakpoint, SlaBadge theme tokens (06-05)
- [x] Docker-based deployment is documented and reproducible on the MSP's own infrastructure — `DEPLOYMENT.md` (06-09)
- [x] Core workflows (ticket lifecycle, time entry to invoice, SLA tracking) pass end-to-end verification — Playwright infra + 3 E2E specs (06-04, 06-06, 06-07, 06-08); note 06-06 found `deleteTicket`'s ownership check has no UI wiring, represented as `test.fixme`, flagged for review
- [x] No critical or high-severity issues open from QA review — ownership-scoped delete, rate limiting, defense-in-depth indexes (06-02, 06-03)
- [x] **CRITICAL (carried forward from Phase 4 review)**: QuickBooksConnection's OAuth access/refresh tokens are encrypted at the application layer before being written to the database — AES-256-GCM via `src/lib/crypto.ts`, wired into `src/lib/qbo.ts` and `src/app/api/qbo/callback/route.ts` (06-01)
**Plans**: 9

---

*Phases 7-9 form the **Launch Readiness (v1 Go-Live)** milestone. Source:
`.planning/explorations/2026-09-02-launch-readiness-design.md` — read it before planning
any of these phases; it carries the decisions, the rejected alternatives, and the
verified line references behind each success criterion.*

### Phase 7: Account Management & Session Freshness
**Goal**: Let an admin onboard and offboard real MSP staff from the UI, with deactivations and role changes taking effect immediately rather than up to 8 hours later.
**Requirements**: Role-based access control (extends the Phase 1 requirement — the admin-facing half was never built)
**Recommended Agents**: engineering-backend-architect, engineering-frontend-developer, engineering-security-engineer
**Success Criteria**:
- [ ] Additive migration adds `User.isActive` (default true) and `User.mustChangePassword` (default false); `prisma/seed.ts` sets both explicitly so the E2E login fixture keeps working
- [ ] `/admin/users` exists, gated on the already-wired `admin:manage_users` permission and linked from the sidebar's Admin section, supporting create / edit-role / reset-password / deactivate / reactivate
- [ ] New-user creation lowercase-normalizes email to match `authorize()`, and shows the generated temp password exactly once without logging it
- [ ] `getCurrentUser()` performs one indexed lookup and returns database `role` / `isActive` / `mustChangePassword`; an inactive or deleted user resolves to null and is treated as unauthenticated
- [ ] Guard rails hold: an admin cannot deactivate or demote themselves, and at least one active admin always remains
- [ ] `/change-password` lives at `(auth)/change-password` (outside the `(dashboard)` gate that redirects to it) and clears `mustChangePassword` on success
- [ ] `npm run bootstrap:admin` creates the first real admin (explicitly `role: "admin"`, password validated against the shared minimum), retiring `ALLOW_SEED_IN_PRODUCTION` as the documented path, with an explicit `--reset-password` break-glass for a locked-out sole admin
- [ ] `authorize()` also refuses inactive users, so deactivation cannot be bypassed by simply logging in again for a fresh JWT — and every failure path still returns an identical null, preserving the anti-enumeration property
- [ ] `requireRole()` itself enforces `mustChangePassword`, so a holder of an intercepted temp password cannot invoke Server Actions; `/api/qbo/connect`, which cannot call `requireRole()`, carries its own equivalent check
- [ ] `resetUserPassword` refuses a self-target, so no admin can strand themselves
- [ ] Phase 7's behavioural claims are executable in `e2e/user-lifecycle.spec.ts` and pass, and the merged tree passes `prisma generate`, `tsc --noEmit` and `lint`
**Plans**: 7

### Phase 8: Deployment Hardening
**Goal**: Make the self-hosted deployment safe to expose — real TLS, a reverse proxy that makes the existing rate limiter meaningful, and no default credentials.
**Requirements**: Cross-cutting deployment security (no new product requirements — hardens the Phase 6 deployment story)
**Recommended Agents**: infrastructure-devops-engineer, engineering-security-engineer, engineering-backend-architect
**Success Criteria**:
- [ ] `src/middleware.ts` is migrated to `src/proxy.ts` (Next.js 16 deprecated the middleware convention; Proxy runs on the Node runtime and cannot be configured back to Edge), the export is renamed to `proxy`, and `tsc --noEmit` passes — re-verify the `authAsMiddleware` overload cast rather than copying it blindly
- [ ] Rate-limit window and thresholds are read from `process.env` with the current values (60s / 60 / 10) as defaults, genuinely runtime-read now that the file is Node-runtime
- [ ] A Caddy service fronts the app with HTTP-01 automatic TLS; `app` no longer publishes 3000 to the host and is reachable only on the internal Compose network
- [ ] `getClientIp()` is trustworthy because Caddy overwrites `X-Forwarded-For` — the trust-boundary warning in the file is updated to say the boundary is now enforced
- [ ] Default `postgres:postgres` credentials are replaced with generated secrets from `.env` in all three places (`db.POSTGRES_PASSWORD`, `app.DATABASE_URL`, `email-poller.DATABASE_URL`) and the host-published `db` port is removed
- [ ] `DEPLOYMENT.md` and `.env.example` reflect the new topology, including that `POSTGRES_PASSWORD` applies only at initdb so an existing volume needs `ALTER USER`
**Plans**: 4

### Phase 9: Verification & Debt Closure
**Goal**: Run the E2E suite against a real browser for the first time and close the three known debt items carried out of Phases 4 and 6.
**Requirements**: Cross-cutting quality (no new product requirements — closes documented debt)
**Recommended Agents**: testing-qa-verification-specialist, engineering-backend-architect, engineering-frontend-developer
**Success Criteria**:
- [ ] `npm run test:e2e` executes against a real browser and passes; any failures caused by `fullyParallel: true` sharing the dev database are recorded explicitly, so the separate-test-database decision can be made on evidence
- [ ] Ticket delete is admin-only and **refuses when any of the ticket's time entries has a non-null `invoiceLineItemId`**, returning an error naming the invoice — `TimeEntry.ticket` is `onDelete: Cascade` (`prisma/schema.prisma:265`) while `TimeEntry.invoiceLineItem` is `SetNull`, so an unguarded delete destroys billed time and leaves the line item that billed it
- [ ] A confirmation dialog wires the ticket detail page to `deleteTicket`, and the two `test.fixme` cases in `e2e/tickets.spec.ts` are rewritten as admin/non-admin and invoiced-time cases
- [ ] `deleteTicket`'s docstring names the `TimeEntry` cascade, not just `TicketComment`
- [ ] The hardcoded QBO `ItemRef.value: "1"` (`src/lib/actions/invoices.ts:367`) is replaced by a connection-level default item chosen from a live QBO item list on `/admin/quickbooks`; the item-list endpoint is verified against the real company or a sandbox first
**Plans**: 3

## Progress

| Phase | Plans | Completed | Status |
|-------|-------|-----------|--------|
| Phase 1: Foundation & Platform Setup | 4 | 4 | Complete |
| Phase 2: CRM Core | 5 | 5 | Complete |
| Phase 3: Ticketing & Service Desk | 4 | 4 | Complete |
| Phase 4: Time Tracking & Billing | 6 | 6 | Complete |
| Phase 5: Reporting & Dashboards | 4 | 4 | Complete |
| Phase 6: Polish & Launch Prep | 9 | 9 | Complete |
| Phase 7: Account Management & Session Freshness | 7 | 0 | Pending |
| Phase 8: Deployment Hardening | 4 | 0 | Pending |
| Phase 9: Verification & Debt Closure | 3 | 0 | Pending |
