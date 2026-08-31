# Project State

## Current Position
- **Phase**: 2 of 6 (complete)
- **Status**: Phase 2 complete -- review passed in 2 cycle(s)
- **Last Activity**: Phase 2 review passed (2026-08-31)

## Progress
```
[########............] 40% — 9/22 plans complete
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

- Phase 2 execution: all 5 plans complete across 3 waves. Wave 1 (02-01 schema/migration/permissions) ran solo; Wave 2 (02-02 Company/Site CRUD + tabbed detail shell) ran solo; Wave 3 (02-03 Contacts, 02-04 Contracts, 02-05 Assets+nav) ran fully in parallel on disjoint files with zero forbidden-file violations across all 5 plans. `npx tsc --noEmit` and `npm run build` both pass cleanly on the final integrated tree.
- Known accepted gaps carried forward from Phase 2 (not blocking, documented per-plan): no delete-confirmation UI for Sites/Contacts/Contracts/Assets; no edit-in-place UI for Company/Contract (Server Actions exist and are RBAC-gated, just not wired to a UI entry point yet); Contract `endDate < startDate` not validated. Flag for Phase 6 polish or address earlier if Phase 3/4 need them.
- Environment note: the `legion-build-phase2` worktree initially showed a spurious `tsc` error on `src/app/layout.tsx` (`LayoutProps` type) during Plan 02-01 due to missing `.next/types` in a fresh worktree; resolved itself by Plan 02-02 once `next build` had run once. Not a code defect — flag for future worktree-based builds if seen again early in a wave.

- Phase 2 review: dynamic panel (testing-qa-verification-specialist, engineering-backend-architect, engineering-frontend-developer), 2 review cycles. Cycle 1 found 1 BLOCKER + 6 unique WARNINGs (8 SUGGESTIONs noted, not required); all 7 must-fix items resolved: empty-state `colSpan` missing on all 4 CRM tab tables (BLOCKER), `NEXT_REDIRECT` digest swallowed in 4 of 5 forms (new shared `src/lib/is-next-redirect-error.ts` helper), `sites.ts` missing P2025 handling on update/delete, `contract.ts` discriminated union missing `.strict()` (was silently stripping cross-type fields instead of rejecting them), `companies.ts` missing `deleteCompany` and missing P2025 handling on `updateCompany`. Cycle 2 re-review: unanimous PASS from all 3 reviewers, zero regressions, zero new findings. Full report: `.planning/phases/02-crm-core/02-REVIEW.md`. Deferred non-blocking suggestions (candidates for Phase 6 polish): aria-invalid/aria-describedby wiring on forms, `@@index` on Prisma FK columns, Suspense boundaries around the 4 tabs, raw checkbox vs shadcn Checkbox, duplicated site-select sentinel constant. One unresolved process risk (not code-fixable): Phase 2's migration has only been verified against a sibling Docker container, not this project's own `db` compose service (port 5432 conflict) — recommend running `prisma migrate deploy` against this project's own compose stack before Phase 3 touches the schema further.
- **Isolation incident during cycle 1 fix dispatch**: the backend fix agent's edits initially landed directly in the shared checkout (not a worktree) because this session failed to call EnterWorktree before dispatching fix agents. Recovered via `git stash` + `EnterWorktree` + `git stash pop` before any commit — no data lost, but flag for future review-loop invocations: enter a worktree before the first fix-cycle dispatch, not just before build-phase dispatches.
- Environment note (confirmed again in cycle 1's worktree): a fresh git worktree lacks its own `node_modules`, so `npm run build` fails with Turbopack's "Could not find the Next.js package" error even though `npx tsc --noEmit` succeeds cleanly. This is a structural worktree-isolation gap (documented since Plan 02-01), not a code defect -- future review/fix cycles in a fresh worktree should treat `tsc --noEmit` as the reliable compile check and not block on `npm run build` failing for this specific reason.

## Next Action
Run `/legion:plan 3` to plan Phase 3: Ticketing & Service Desk
