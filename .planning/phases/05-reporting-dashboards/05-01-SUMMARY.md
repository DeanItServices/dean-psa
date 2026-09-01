# Plan 05-01 Summary — Reporting Permissions, Indexes & Query Helpers

## Status: Complete

## Files changed
- `prisma/schema.prisma` — added `@@index([startedAt])` to `TimeEntry`, `@@index([companyId])` to `Ticket`. No other schema change.
- `prisma/migrations/20260901170240_add_reporting_indexes/migration.sql` — new migration (see SQL below).
- `prisma/migrations/migration_lock.toml` — touched only by Prisma's own tooling (line-ending normalization), part of the allowed `prisma/migrations/**` write target.
- `src/lib/permissions.ts` — extended `Permission` union with `"report:view_own"` / `"report:view_all"`; extended `ROLE_PERMISSIONS` for all 5 roles; added exported `REPORT_VIEW_ALL_ROLES: Role[] = ["dispatcher", "finance", "admin"]` with doc comment.
- `src/lib/reporting.ts` (new) — `parseDateRangeBoundaries`, `getCurrentMonthRange`, `getTechnicianUtilization`, `getSlaCompliance`, `getClientProfitability`, plus an internal (non-exported) `countWeekdays` helper.

## Migration SQL (`20260901170240_add_reporting_indexes/migration.sql`)
```sql
-- CreateIndex
CREATE INDEX "Ticket_companyId_idx" ON "Ticket"("companyId");

-- CreateIndex
CREATE INDEX "TimeEntry_startedAt_idx" ON "TimeEntry"("startedAt");
```

## Verification commands and outputs

```
$ npx prisma validate
The schema at prisma\schema.prisma is valid 🚀

$ npx tsc --noEmit
(no output — exit 0)

$ grep -q 'report:view_own' src/lib/permissions.ts && echo FOUND
FOUND

$ grep -q 'report:view_all' src/lib/permissions.ts && echo FOUND
FOUND

$ grep -q 'REPORT_VIEW_ALL_ROLES' src/lib/permissions.ts && echo FOUND
FOUND

$ test -f src/lib/reporting.ts && echo FOUND
FOUND

$ grep -q 'export async function getTechnicianUtilization' src/lib/reporting.ts && echo FOUND
FOUND

$ grep -q 'export async function getSlaCompliance' src/lib/reporting.ts && echo FOUND
FOUND

$ grep -q 'export async function getClientProfitability' src/lib/reporting.ts && echo FOUND
FOUND

$ grep -q 'export function parseDateRangeBoundaries' src/lib/reporting.ts && echo FOUND
FOUND

$ grep -q 'toNumber' src/lib/reporting.ts && echo FOUND
FOUND
```

### Live pg_indexes verification (not just migration file text)
```
$ docker compose exec db psql -U postgres -d msp_psa -c "SELECT indexname, tablename FROM pg_indexes WHERE tablename IN ('TimeEntry', 'Ticket') ORDER BY tablename, indexname;"

              indexname              | tablename
-------------------------------------+-----------
 Ticket_companyId_idx                | Ticket
 Ticket_pkey                         | Ticket
 TimeEntry_one_active_timer_per_user | TimeEntry
 TimeEntry_pkey                      | TimeEntry
 TimeEntry_startedAt_idx             | TimeEntry
(5 rows)
```
Both `Ticket_companyId_idx` and `TimeEntry_startedAt_idx` confirmed present on the live database (alongside the pre-existing `TimeEntry_one_active_timer_per_user` partial unique index from Phase 4, which was untouched).

### Scope check
```
$ git status --porcelain
 M prisma/migrations/migration_lock.toml
 M prisma/schema.prisma
 M src/lib/permissions.ts
?? prisma/migrations/20260901170240_add_reporting_indexes/
?? src/lib/reporting.ts
```
No forbidden-target file (`src/lib/sla.ts`, `src/lib/billing.ts`, `src/lib/timer.ts`, `src/lib/qbo.ts`, `src/lib/actions/**`, `src/app/(dashboard)/reports/**`, `src/components/nav/app-sidebar.tsx`, `package.json`) was touched in the final state.

## Decisions made

- **Field names confirmed as expected, no deviations required.** `prisma/schema.prisma` matched 05-CONTEXT.md exactly for all fields this plan reads: `Ticket.companyId`, `Ticket.slaResponseDeadline`/`slaResolutionDeadline`/`firstRespondedAt`/`resolvedAt`; `TimeEntry.startedAt`/`endedAt`/`durationMinutes`/`isBillable`/`userId`/`contractId` (and no direct `companyId` column, confirmed — only reachable via `TimeEntry.ticket.companyId`); `Invoice.companyId`/`contractId`/`periodStart`/`periodEnd`/`status`/`total` (Decimal); `Contract.hourlyRate`/`blockHours`/`flatFeeAmount`. No BLOCKED condition arose.
- **`reporting.ts` module classification**: implemented as a DB-backed query-helper module (imports `db` directly, no `"use server"`), matching 05-CONTEXT.md's explicit distinction from the fully pure `sla.ts`/`billing.ts`/`timer.ts` precedent. Documented this in the file's top-of-module doc comment.
- **`getTechnicianUtilization` self-view implementation**: rather than special-casing the single-user path, it reuses the same eligible-users-first-then-merge structure for both the self-view (`userId` provided → `findMany({ where: { id: userId } })`) and cross-technician view (`findMany({ where: { role: { in: TIME_ENTRY_MANAGE_ROLES } } })`). This guarantees a valid self-view always returns exactly one row (0 minutes if no activity) without a separate code path, and reuses one `groupBy` for the minutes sum in both cases.
- **`getSlaCompliance` implementation approach**: the "met"/"breached" comparison (e.g. `firstRespondedAt <= slaResponseDeadline`) compares two columns on the *same row*, which Prisma's standard `where` filter API cannot express (no field-to-field comparison operator). Implemented as: fetch every ticket in range with at least one non-null SLA deadline via `findMany`, then classify each leg in JS using the exact nested AND/OR precedence locked in 05-CONTEXT.md (`slaResponseDeadline IS NOT NULL AND (...)`, not a flattened equivalent). This satisfies the "implement as Prisma's nested AND/OR query builder... this exact logical structure" instruction in spirit — the outer `IS NOT NULL` guard plus the exact OR grouping is preserved in the JS `if`/`else if` structure — while working around Prisma's inability to compare two columns of the same row inside a `where` clause. Noted here since the plan's prose describes this as a Prisma query-builder shape; a literal `db.ticket.count()` with that grouping is not achievable for a cross-column comparison, so the fetch-then-classify approach was used instead, preserving identical met/breached semantics.
- **`getClientProfitability` companyId filtering on the hours-half**: per the plan's explicit allowance ("filter in JS post-query on `ticket.companyId`... either approach is acceptable if correct"), implemented as a JS-side `continue` skip inside the reduce loop rather than a nested-relation Prisma `where` filter, keeping the query itself simple.
- **`countWeekdays`**: implemented as a simple day-by-day loop (not a closed-form calculation) for clarity and correctness over performance, since date ranges for this report are expected to be at most a few months (page-level filter, not an unbounded range).

## Deviations from the plan and why

- **Unintended `package.json` side effect, reverted.** Running `npx prisma migrate dev --name add_reporting_indexes` triggered npm's script-allowlist mechanism, which auto-wrote an `"allowScripts"` block to `package.json` (a forbidden write target per this plan's `files_forbidden`). This was not a manual edit — it was an automatic side effect of the migrate command in this environment. Reverted via `git checkout -- package.json` immediately after detection, and re-verified `npx tsc --noEmit` / `npx prisma validate` still pass post-revert. Final `git status` confirms `package.json` is clean (not in the changed-files list).
- **`prisma/migrations/migration_lock.toml` shows a diff** (CRLF/LF line-ending normalization only, no content change) — this is Prisma's own tooling touching a file inside the explicitly-allowed `prisma/migrations/**` write target, not a manual edit and not a scope violation.
- No other deviations. All five required exports (`parseDateRangeBoundaries`, `getCurrentMonthRange`, `getTechnicianUtilization`, `getSlaCompliance`, `getClientProfitability`) implement the exact signatures and logic specified in 05-01-PLAN.md's execution contract, including: local (non-UTC) date boundary construction via the `Date` constructor's numeric-args form; the utilization completeness fix (every `TIME_ENTRY_MANAGE_ROLES` user returned, including 0-minute technicians); the SLA breach nested-AND/OR precedence; the Invoice period-overlap condition (`periodStart <= toDate AND periodEnd >= fromDate`); the JS-reduce join for `TimeEntry`-to-`Company` grouping (never an invalid cross-model `groupBy`); and `hoursInvested` never converted to or blended with a dollar figure.

## Issues/errors
None. No BLOCKED condition encountered — the schema matched the phase context's documented field names exactly.
