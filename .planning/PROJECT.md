# MSP PSA

## What This Is
An in-house Professional Services Automation (PSA) platform built for internal use at the MSP. It replaces ConnectWise Manage / Autotask as the system of record for ticketing, time tracking and billing, client relationship management, and operational reporting. Built as a modern web application (Next.js + TypeScript + PostgreSQL) with a fast, clean UI, self-hosted on the MSP's own infrastructure.

## Core Value
Modern UX and speed. ConnectWise Manage and Autotask are widely regarded as slow and clunky; the core differentiator of this tool is that day-to-day work (dispatching tickets, logging time, checking client status) is fast and pleasant instead of a fight with the interface.

## Who It's For
- **MSP technicians/engineers** — work tickets, log time, resolve client issues day-to-day.
- **Dispatch/service desk managers** — triage, assign, and prioritize incoming tickets and workload.
- **Account managers/sales** — manage client relationships, contracts, and renewals.
- **Finance/billing admin** — handle invoicing, time-to-bill reconciliation, and contract billing rules.

## Requirements

### Validated
(None yet — ship to validate)

### Active
- [ ] Role-based access control (technician / dispatcher / sales / finance / admin roles)
- [ ] Client companies & multi-site records
- [ ] Contacts per client company
- [ ] Contracts / service agreements per client (defines billing terms and SLA targets)
- [ ] Asset/device tracking tied to clients and tickets
- [ ] Kanban-style ticket boards/queues for dispatch
- [ ] Email-to-ticket creation
- [ ] SLA timers and breach escalation, driven by contract terms
- [ ] Timer-based time entry against tickets
- [ ] Contract-based billing rules (block hours, flat-fee managed services, hourly break-fix, etc.)
- [ ] Invoice generation from logged time and contract terms
- [ ] Accounting integration (QuickBooks or Xero) for pushing invoices
- [ ] Technician utilization/workload reporting
- [ ] SLA compliance reporting
- [ ] Client profitability reporting (revenue vs. time spent per client)

### Out of Scope
- Client self-service portal (external-facing ticket submission/view) — deferred past v1
- Data migration from ConnectWise/Autotask — starting fresh, no legacy import in v1
- Project management module (Gantt/phases/tasks) — separate concern from day-to-day ticketing
- Deep RMM integrations (auto-ticket-from-alert) — deferred to a later phase

## Constraints
- No hard deadline — ongoing internal project
- Self-hosted on private/on-prem infrastructure (not cloud-hosted)
- Sized for a small MSP team (well under ~25 internal users, a few hundred client companies) — optimize for simplicity over massive scale
- Handles sensitive client data — auth and access control matter even without an explicit compliance mandate stated

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Tech stack: Next.js + TypeScript + PostgreSQL + Docker | Modern, fast, well-suited to a CRUD-heavy internal business app with real-time UI needs; self-hostable via Docker | Adopted |
| Self-hosted deployment | MSP already runs its own infrastructure; avoids recurring cloud costs for an internal tool | Adopted |
| Full v1 scope covers ticketing, billing, CRM, and reporting | User confirmed all four are needed for this to functionally replace ConnectWise/Autotask, not just partially | Adopted — drives Deep Analysis planning depth |
| No data migration in v1 | Starting fresh simplifies initial scope; legacy PSA data stays in old system for reference | Adopted |
| Role-based access control from day one | Matches the four distinct user types (technician, dispatch, sales, finance) with different needs and data visibility | Adopted |
| Execution mode: Guided | First build of a high-stakes internal system of record — user wants to approve steps before they happen | Adopted |
| Planning depth: Deep Analysis | Full PSA replacement across 4 major modules is a complex, unfamiliar-domain build that benefits from thorough upfront planning | Adopted |
| Cost profile: Balanced | Opus for planning, Sonnet for execution, Haiku for checks — best cost/quality ratio for this scope | Adopted |

## Architecture Influences
- **Frontend**: Next.js (React) with shadcn/ui + Tailwind CSS for a modern, consistent component system
- **Backend**: Node.js/TypeScript (Next.js API routes or a dedicated Node service)
- **Database**: PostgreSQL
- **Deployment**: Docker, self-hosted
- **Competitive context**: ConnectWise Manage and Autotask are the direct incumbents being replaced — both are broad, dated enterprise PSAs; the opportunity is a focused, modern subset that fits this MSP's actual workflow rather than matching every enterprise feature

---
*Last updated: 2026-08-30 after initialization*
