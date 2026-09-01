# Phase 4: Time Tracking & Billing — Review Summary

## Result: PASSED
**Cycles Used**: 3 of 3
**Reviewers**: testing-qa-verification-specialist, engineering-backend-architect, engineering-security-engineer
**Completed**: 2026-09-01

## Findings Summary
| Metric               | Count |
|-----------------------|-------|
| Total findings        | 14    |
| Blockers found        | 3     |
| Blockers resolved      | 3     |
| Warnings found         | 4     |
| Warnings resolved      | 4     |
| Suggestions (noted)    | 7     |

## Findings Detail

| # | Severity | File | Issue | Fix Applied | Cycle Fixed |
|---|----------|------|-------|-------------|-------------|
| 1 | BLOCKER | prisma/schema.prisma | `TimeEntry.invoiceLineItemId` wrongly `@unique`, inverting the intended one-to-many `InvoiceLineItem -> TimeEntry` relationship; broke `generateInvoice` for any period with 2+ billable time entries against a block-hour contract | Removed `@unique`; corrective migration `20260901030000_fix_time_entry_invoice_line_item_not_unique` dropped `TimeEntry_invoiceLineItemId_key` on the live DB, verified via direct `pg_indexes` query and a live SQL reproduction of the original failure (now succeeds) | 1 |
| 2 | BLOCKER | src/lib/actions/invoices.ts | Same root cause as #1 — flat-fee invoices also broke with 2+ time entries in a period | Auto-resolved by #1's schema fix | 1 |
| 3 | BLOCKER | src/app/(dashboard)/admin/quickbooks/page.tsx | Empty-state table row missing `colSpan` against a 3-column header (the exact pattern flagged as a real BLOCKER in Phase 2 review) | Added `colSpan={3}` | 1 |
| 4 | WARNING | prisma/migrations/.../migration.sql | One-active-timer-per-user partial unique index was applied out-of-band via manual `psql` and not part of what `prisma migrate deploy` would apply to a fresh environment | Added `db:migrate:deploy` script chaining `prisma migrate deploy && bash scripts/post-migrate.sh`; `post-migrate.sh` idempotently creates the index (`IF NOT EXISTS`) | 1 |
| 5 | WARNING | src/lib/actions/invoices.ts | `periodEnd` coerced to midnight, silently excluding time entries logged later that day from invoice generation | Added `periodEndInclusive` (23:59:59.999) used only in the query filter; `Invoice.periodEnd` still stores the original user-selected date | 1 |
| 6 | WARNING | src/lib/qbo.ts | `getValidQboClient()`'s token-refresh failure silently swallowed with no logging | Added `console.error` before returning null; return contract unchanged | 1 |
| 7 | WARNING | src/lib/actions/invoices.ts | `pushInvoiceToQbo`'s 5 failure branches (network error, 401, non-ok response, missing Invoice.Id, partial-failure local-update-fails) had no server-side logging — the cycle-1 fix addressed a different function and missed this one | Added `console.error` at all 5 branches; partial-failure branch flagged as requiring manual reconciliation; verified no OAuth tokens are logged | 2 |

## Reviewer Verdicts

| Reviewer | Cycle 1 | Cycle 2 | Cycle 3 | Key Observations |
|----------|---------|---------|---------|-------------------|
| testing-qa-verification-specialist | NEEDS WORK (3 BLOCKER, 2 WARNING, 2 SUGGESTION) | PASS | — | Found the schema/action mismatch the other two reviewers missed; independently reproduced the original P2002 failure via a live SQL transaction before and after the fix |
| engineering-backend-architect | PASS (3 SUGGESTION) | PASS | — | Independently re-verified all fixes against live DB state (pg_indexes, migration history, generated Prisma types); surfaced one new SUGGESTION (Docker Compose port collision between worktrees) |
| engineering-security-engineer | NEEDS WORK (0 BLOCKER, 1 WARNING, 3 SUGGESTION) | NEEDS WORK (1 WARNING carried forward — logging fix landed in wrong function) | PASS | Correctly caught that cycle 1's logging fix addressed `getValidQboClient()` instead of the originally-flagged `pushInvoiceToQbo`; confirmed cycle 2's fix and verified no secrets leak into logs |

## Carried-Forward Critical (upgraded post-review, tracked for Phase 6)

- **OAuth token encryption at rest** — `QuickBooksConnection.accessToken`/`refreshToken` are stored in plaintext `@db.Text` columns with no application-level encryption. Originally reported by the Security Engineer as a SUGGESTION during Phase 4 review (accepted at the time as reasonable for this project's self-hosted, single-org, <25-user threat model). **Reclassified to CRITICAL by user decision on 2026-09-01** — not accepted as residual risk. These tokens grant live read/write access to the MSP's real QuickBooks Online company file (actual client financial/invoicing data), so plaintext storage is a genuine exposure via DB backups, read replicas, or any lower-privileged access to the Postgres instance, independent of the app's own access controls. Tracked as a locked success criterion on **Phase 6: Polish & Launch Prep** (`.planning/ROADMAP.md`) — encrypt `accessToken`/`refreshToken` at the application layer (e.g. AES-256-GCM with a key derived from a new dedicated env var, decrypting only inside `src/lib/qbo.ts`) before Phase 6 can be marked complete. Do not defer past Phase 6.

## Suggestions (Not Required)

- `resolveActiveContract`'s query logic remains duplicated (not shared) between `tickets.ts` and `invoices.ts` — a pattern already accepted since Phase 3.
- `src/components/nav/app-sidebar.tsx` has a redundant/dead nested permission check on the Admin nav item (both `qbo:manage` and `admin:manage_users` currently resolve identically to admin-only, making the inner OR branch unreachable) — independently flagged by both QA and Backend Architect.
- `realmId` from the OAuth callback is not format-validated (`/^\d+$/`) before being embedded in the QBO API URL path — low exploitability given the `state`-parameter CSRF check already gates the callback, but cheap defense-in-depth.
- `src/lib/actions/invoices.ts`'s lifetime prior-invoiced aggregate omits an explicit `isBillable: true` filter (currently safe by construction since only billable entries ever get an `invoiceLineItemId`, but an implicit rather than explicit invariant).
- No unique/partial index on `Invoice.qboInvoiceId` — the idempotency guard's atomic `updateMany` claim is already race-safe without it, but a unique index would be a belt-and-suspenders guarantee against duplicate QBO invoice IDs.
- A block-hour contract with billable entries but zero overage in a period will still generate a $0.00 invoice that consumes (stamps) those entries — may be intended, flagged for product confirmation.
- Docker Compose port collision: this worktree's own `db` service does not publish a host port, so all Phase 4 database verification actually ran against a different, shared `dean-psa2-db-1` container occupying host port 5432 — harmless currently but would corrupt migration history/data if two worktrees ran concurrently. Recommend distinct host port mappings per worktree/compose-project before parallel worktree work resumes.
