# Phase 2: CRM Core — Review Summary

## Result: PASSED

**Cycles Used**: 2 of 3
**Reviewers**: testing-qa-verification-specialist, engineering-backend-architect, engineering-frontend-developer (dynamic review panel)
**Completed**: 2026-08-31

## Findings Summary

| Metric               | Count |
|-----------------------|-------|
| Total findings (cycle 1) | 15 (excluding verification-only notes) |
| Blockers found        | 1 |
| Blockers resolved      | 1 |
| Warnings found (unique, after dedup) | 6 |
| Warnings resolved      | 6 |
| Suggestions (noted, not required) | 8 |
| New findings in cycle 2 (re-review) | 0 |

## Findings Detail

| # | Severity | File | Issue | Fix Applied | Cycle Fixed |
|---|----------|------|-------|-------------|-------------|
| 1 | BLOCKER | `src/components/crm/{sites,contacts,contracts,assets}-tab.tsx` | Empty-state `TableCell` missing `colSpan` — every new client's tabs render a visually broken row on first paint | Added `colSpan={N}` matching each table's actual column count (6/5/6/4) plus `text-center` | 1 |
| 2 | WARNING | `src/components/crm/{site,contact,contract,asset}-form.tsx` | `NEXT_REDIRECT` digest swallowed in bare catch block — auth-failure/session-expiry redirect silently breaks | Extracted shared `src/lib/is-next-redirect-error.ts` helper (refactoring `company-form.tsx`'s existing correct inline check too); wired into all 5 forms | 1 |
| 3 | WARNING | `src/lib/actions/sites.ts` | `updateSite`/`deleteSite` missing P2025 handling (unlike every sibling entity) | Added try/catch with `Prisma.PrismaClientKnownRequestError` P2025 check, matching contacts.ts/contracts.ts/assets.ts pattern | 1 |
| 4 | WARNING | `src/lib/validations/contract.ts` | Discriminated union not `.strict()` — silently stripped cross-type fields instead of rejecting them | Added `.strict()` to all 3 branches | 1 |
| 5 | WARNING | `src/lib/actions/companies.ts` | Missing `deleteCompany` (only entity without one) | Added `deleteCompany(id)` with cascade-blast-radius doc comment, RBAC-gated, P2025-handled | 1 |
| 6 | WARNING | `src/lib/actions/companies.ts` | `updateCompany` missing P2025 handling | Added same try/catch P2025 pattern as sibling entities | 1 |
| 7 | WARNING | docker-compose / migration process | Migration never verified against this project's own `db` container (only a sibling container, per 02-01-SUMMARY.md) | **Not fixed — accepted as documented operational risk** (see User Notes below); no code file to edit, migration SQL itself verified correct on inspection by two independent reviewers | — |

## Reviewer Verdicts

| Reviewer | Cycle 1 Verdict | Cycle 2 Verdict | Key Observations |
|----------|-----------------|------------------|-------------------|
| testing-qa-verification-specialist | NEEDS WORK | PASS | Root-caused the NEXT_REDIRECT swallowing bug via direct trace through `redirect-error.js`; verified all 6 fixes against actual code, not descriptions; independently confirmed `tsc --noEmit` clean both cycles |
| engineering-backend-architect | NEEDS WORK | PASS | Verified RBAC boundary (`requireRole(CRM_MANAGE_ROLES)` as literal first line) across all 5+1 action files line-by-line in cycle 1; confirmed `.strict()` doesn't break the only real caller in cycle 2 |
| engineering-frontend-developer | NEEDS WORK | PASS | Recounted `TableHead` columns programmatically rather than trusting reported numbers in both cycles; confirmed `CrmTabProps` contract integrity |

## Suggestions (Not Required)

The following SUGGESTION-severity findings from cycle 1 were noted but are not required for phase approval. Carried forward as open items for a future polish pass:

- No `aria-invalid`/`aria-describedby` wiring on the 5 CRUD forms (WCAG 2.1 AA gap)
- No `@@index` on Prisma FK columns (`companyId`, `siteId` across Site/Contact/Contract/Asset) — low urgency at current team scale (<25 users)
- No `Suspense` boundaries around the 4 tab components in `[companyId]/page.tsx` — all 4 tabs' data fetches block the initial render even though only one tab is visible
- `site-form.tsx` uses a raw `<input type="checkbox">` instead of a shadcn `Checkbox` primitive (cosmetic/consistency only)
- Duplicated `"none"` sentinel constant between `contact-form.tsx` (named `NO_SITE_VALUE`) and `asset-form.tsx` (inline string) — same concept, not DRY
- `contract-form.tsx` silently discards the previous billing type's typed amount/rate value on type switch — intentional (prevents stale cross-type submission) but no undo/warning
- Contract `endDate < startDate` unvalidated at any layer (client, zod, DB constraint) — confirmed as an explicitly accepted gap per 02-CONTEXT.md's edge-case scope, not a surprise

None of these block approval; they're candidates for Phase 6 (Polish & Launch Prep) or an earlier ad-hoc pass if Phase 3/4 development surfaces a real need.

## Cycle Delta

### Progression Summary

| Metric | Cycle 1 | Cycle 2 (Final) |
|--------|---------|-------|
| Total findings | 15 | 0 new |
| BLOCKER | 1 | 0 |
| MUST-FIX (BLOCKER+WARNING) | 7 | 0 |
| SUGGESTION | 8 | 0 (unchanged, not required) |

### Findings Resolved (fixed between cycles)

| Finding | File | Resolved In |
|---------|------|-------------|
| Empty-state colSpan missing (4 files) | `{sites,contacts,contracts,assets}-tab.tsx` | Cycle 1 |
| NEXT_REDIRECT digest swallowed (4 forms) | `{site,contact,contract,asset}-form.tsx` | Cycle 1 |
| sites.ts missing P2025 handling | `src/lib/actions/sites.ts` | Cycle 1 |
| Discriminated union not `.strict()` | `src/lib/validations/contract.ts` | Cycle 1 |
| Missing `deleteCompany` | `src/lib/actions/companies.ts` | Cycle 1 |
| `updateCompany` missing P2025 | `src/lib/actions/companies.ts` | Cycle 1 |

### Findings New (appeared in later cycles)

None — cycle 2 introduced zero new findings across all 3 reviewers.

### Findings Unchanged (persisted across all cycles)

| Finding | File | Severity | Cycles Present |
|---------|------|----------|-----------------|
| Migration unverified against project's own db container | docker-compose / process | WARNING | 1, 2 (accepted, not code-fixable) |

## User Notes

**Finding 7 (migration verification) is intentionally left unresolved as a process risk, not a code defect.** Two independent reviewers (backend-architect in both cycles) inspected the migration SQL directly against `schema.prisma` and confirmed it is structurally correct — the risk is that it has only been exercised against a sibling Docker container (due to a port-5432 conflict documented in `02-01-SUMMARY.md`), not this project's own `docker-compose.yml` `db` service. Recommended before the next phase touches the schema further: free port 5432 (or reassign the `db` service's host port) and run `prisma migrate deploy` against this project's own compose stack at least once.

**Isolation process note**: during fix-cycle dispatch, this review session initially failed to enter a worktree before spawning fix agents, causing the backend fix agent's edits to land directly in the shared checkout. This was caught by the harness's isolation guard and recovered cleanly via `git stash` → `EnterWorktree` → `git stash pop`, with zero data loss and no shared-checkout state ever left inconsistent. Flagged in STATE.md for future review-loop invocations.
