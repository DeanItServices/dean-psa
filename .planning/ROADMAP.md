# MSP PSA — Roadmap

## Phases

- [x] Phase 1: Foundation & Platform Setup (4 plans)
- [x] Phase 2: CRM Core (5 plans)
- [x] Phase 3: Ticketing & Service Desk (4 plans)
- [x] Phase 4: Time Tracking & Billing (6 plans) — Complete
- [ ] Phase 5: Reporting & Dashboards (3 plans)
- [ ] Phase 6: Polish & Launch Prep (2 plans)

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
**Recommended Agents**: data-analytics-engineer, engineering-frontend-developer, engineering-backend-architect
**Success Criteria**:
- [ ] Dashboard shows technician utilization (time logged vs. capacity) over a selectable date range
- [ ] SLA compliance report shows % of tickets meeting response/resolution targets, filterable by client/contract
- [ ] Client profitability view compares billed revenue against time invested per client
- [ ] Dashboards respect role permissions (e.g. finance/leadership see profitability; technicians see their own utilization)
**Plans**: 3

### Phase 6: Polish & Launch Prep
**Goal**: Harden the application for real daily use — performance, UX consistency, and self-hosted deployment readiness.
**Requirements**: Cross-cutting quality across all v1 modules (no new requirements — hardens Phases 1-5)
**Recommended Agents**: engineering-frontend-developer, testing-qa-verification-specialist, infrastructure-devops-engineer, engineering-security-engineer
**Success Criteria**:
- [ ] UI is consistent and responsive across all modules (ticketing, CRM, billing, reporting)
- [ ] Docker-based deployment is documented and reproducible on the MSP's own infrastructure
- [ ] Core workflows (ticket lifecycle, time entry to invoice, SLA tracking) pass end-to-end verification
- [ ] No critical or high-severity issues open from QA review
- [ ] **CRITICAL (carried forward from Phase 4 review)**: QuickBooksConnection's OAuth access/refresh tokens are encrypted at the application layer before being written to the database (currently stored in plaintext `@db.Text` columns) — see `.planning/phases/04-time-tracking-billing/04-REVIEW.md`
**Plans**: 2

## Progress

| Phase | Plans | Completed | Status |
|-------|-------|-----------|--------|
| Phase 1: Foundation & Platform Setup | 4 | 4 | Complete |
| Phase 2: CRM Core | 5 | 5 | Complete |
| Phase 3: Ticketing & Service Desk | 4 | 4 | Complete |
| Phase 4: Time Tracking & Billing | 6 | 6 | Complete |
| Phase 5: Reporting & Dashboards | 3 | 0 | Not started |
| Phase 6: Polish & Launch Prep | 2 | 0 | Not started |
