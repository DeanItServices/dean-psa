# Project State

## Current Position
- **Phase**: 2 of 6 (planned)
- **Status**: Phase 2 planned -- 5 plans across 3 waves
- **Last Activity**: Phase 2 planning (2026-08-31)

## Progress
```
[####················] 21% — 4/19 plans complete
```

## Recent Decisions
- Tech stack: Next.js + TypeScript + PostgreSQL + Docker, self-hosted
- Execution mode: Guided
- Planning depth: Deep Analysis (6 phases)
- Cost profile: Balanced
- No data migration from ConnectWise/Autotask — starting fresh
- Client self-service portal explicitly deferred past v1
- Phase 1 architecture: Pragmatic approach (NextAuth/Auth.js v5 + Prisma + enum roles with centralized can() permission matrix, full Docker Compose) selected from 3 competing proposals
- Phase 1 plan critique (pre-mortem + assumption hunting) surfaced 1 CRITICAL and 3 HIGH findings; all fixed via plan revision before execution
- **Session strategy changed from database to JWT**: Auth.js v5 unconditionally rejects database sessions combined with a Credentials-only provider. Instant server-side session revocation is not currently available — flag for future phases if that becomes a real requirement (would need a token-blocklist table). JWT maxAge set to 8 hours to bound exposure.
- Node.js upgraded system-wide from v20.0.0 to v24.19.0 LTS (Next.js 16 requires >=20.9.0)
- Prisma pinned to stable 7.10.0 (npm's `latest` tag resolved to an 8.0.0-rc pre-release); requires an explicit `@prisma/adapter-pg` driver adapter passed to every `PrismaClient` instantiation
- Seeded local dev test users: technician/dispatcher/sales/finance/admin @mspdemo.local, all password `Password123!` (local dev only, never for production) — protected by a NODE_ENV=production guard in the seed script
- Phase 1 review: dynamic panel (QA verification specialist, security engineer, backend architect), 2 review cycles, 2 blockers + 6 warnings found and fixed (all in Docker/env-config completeness, not core auth logic). Deferred non-blocking suggestions: rename middleware.ts to proxy.ts (Next.js 16 convention), consolidate duplicated PrismaClient construction, add rate limiting before internet exposure.
- Post-review polish: skipped (user choice, session context constraints)
- Phase 2 architecture: Pragmatic approach (flat relational schema: Company 1:N Site/Contact/Contract/Asset; Contract uses a BillingType enum + nullable typed columns, not a JSON blob or per-type subtables) selected from 3 competing proposals
- Phase 2 decomposed into 5 plans across 3 waves: 02-01 (schema+migration+permissions, Wave 1) -> 02-02 (Company/Site CRUD + shared tabbed detail-page shell, Wave 2) -> 02-03/02-04/02-05 (Contacts/Contracts/Assets CRUD, Wave 3, each replacing a placeholder stub component behind a shared `CrmTabProps` type contract)
- Phase 2 plan critique (pre-mortem + assumption hunting) surfaced 1 CRITICAL and 3 HIGH findings, all fixed via plan revision before execution:
  - **RBAC scope corrected**: `crm:manage` (create/edit/delete on Companies/Sites/Contacts/Contracts/Assets) now grants to **sales, finance, admin only** — NOT dispatcher, NOT technician. The original decomposition had granted it to dispatcher too, which exceeded PROJECT.md's described dispatch persona (ticket/workload triage, not client/contract ownership). All 5 roles retain `crm:view`.
  - A shared `CRM_MANAGE_ROLES` constant is exported from `src/lib/permissions.ts` so all 5 CRM Server Action files import one source of truth instead of each hardcoding its own role array.
  - A shared `CrmTabProps` type (`src/components/crm/tab-types.ts`) replaces prose-only prop-signature matching between Plan 02-02's placeholder stubs and the 3 Wave 3 plans that replace them — `tsc --noEmit` now catches any drift.
  - Wave 3 plans (02-04, 02-05) gained the same graceful "read the real source code, don't block on doc ambiguity" stop-gate fallback that 02-03 already had for the not-yet-existing `02-02-SUMMARY.md`.

## Next Action
Run `/legion:build` to execute Phase 2: CRM Core
