# MSP PSA — Roadmap

## Phases

- [x] Phase 1: Foundation & Platform Setup (4 plans)
- [x] Phase 2: CRM Core (5 plans)
- [x] Phase 3: Ticketing & Service Desk (4 plans)
- [x] Phase 4: Time Tracking & Billing (6 plans) — Complete
- [x] Phase 5: Reporting & Dashboards (4 plans) — Complete
- [x] Phase 6: Polish & Launch Prep (9 plans) — Executed, pending review

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

## Progress

| Phase | Plans | Completed | Status |
|-------|-------|-----------|--------|
| Phase 1: Foundation & Platform Setup | 4 | 4 | Complete |
| Phase 2: CRM Core | 5 | 5 | Complete |
| Phase 3: Ticketing & Service Desk | 4 | 4 | Complete |
| Phase 4: Time Tracking & Billing | 6 | 6 | Complete |
| Phase 5: Reporting & Dashboards | 4 | 4 | Complete |
| Phase 6: Polish & Launch Prep | 9 | 9 | Complete |
