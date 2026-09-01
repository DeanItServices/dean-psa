# Plan 05-04 Summary — Client Profitability Report

## Status: Complete

## Files changed
- `src/components/reports/profitability-table.tsx` (new) — renders `ProfitabilityRow[]` (type imported from `@/lib/reporting`). Columns: Client, Billed Revenue (currency via `toLocaleString("en-US", { style: "currency", currency: "USD" })`, matching `invoice-line-table.tsx`'s `formatCurrency` pattern), Hours Invested (formatted as e.g. `"42.5h"`). Empty-state row uses `colSpan={COLUMN_COUNT}` (`COLUMN_COUNT = 3`, matching the actual column count). Visible `<p>` disclaimer below the table stating the report compares billed revenue to hours invested, not a computed dollar cost or profit margin.
- `src/app/(dashboard)/reports/profitability/page.tsx` (new) — async Server Component. `searchParams` typed as `Promise<{ from?: string; to?: string; companyId?: string; contractId?: string }>`, awaited. First two logic lines: `getCurrentUser()` then `if (!user) redirect("/login")`, preceding any `can()` call. Then `if (!can(user.role, "report:view_all")) redirect("/unauthorized")`. `from`/`to` parsed as raw strings with a `/^\d{4}-\d{2}-\d{2}$/` shape check, falling back per-field to `getCurrentMonthRange()`; no `Date` construction in this file. `companyId`/`contractId` parsed as optional raw strings, passed straight through. Calls `getClientProfitability(from, to, companyId, contractId)`. Renders the reused `DateRangeFilter` (from 05-02, unmodified) + `ProfitabilityTable`.
- `src/components/nav/app-sidebar.tsx` — **NOT modified.** Confirmed via `grep -q 'href="/reports/utilization"' src/components/nav/app-sidebar.tsx` (matched) that Plan 05-02 already added the Reports nav item. File left completely untouched.

## Verification commands and outputs

```
$ npx tsc --noEmit
(no output — exit 0 / "TSC_EXIT_0")

$ test -f 'src/app/(dashboard)/reports/profitability/page.tsx' && echo PASS
PASS

$ grep -n 'report:view_all' 'src/app/(dashboard)/reports/profitability/page.tsx'
12: * can(role, "report:view_all") only -- report:view_own alone does not grant
35:  if (!can(user.role, "report:view_all")) {

$ grep -n 'getClientProfitability' 'src/app/(dashboard)/reports/profitability/page.tsx'
4:import { getClientProfitability, getCurrentMonthRange } from "@/lib/reporting";
47:  const rows = await getClientProfitability(from, to, companyId, contractId);

$ test -f src/components/reports/profitability-table.tsx && echo PASS
PASS

$ grep -q 'href="/reports/utilization"' src/components/nav/app-sidebar.tsx && echo SIDEBAR_ALREADY_PRESENT
SIDEBAR_ALREADY_PRESENT
```

### Scope check
```
$ git status --porcelain
?? src/app/(dashboard)/reports/profitability/
?? src/components/reports/profitability-table.tsx
```
Only the two planned new files appear. `src/components/nav/app-sidebar.tsx` does NOT appear in git status, confirming it was left completely untouched (already had the Reports link from 05-02). No forbidden-target file (`prisma/schema.prisma`, `prisma/migrations/**`, `src/lib/permissions.ts`, `src/lib/reporting.ts`, `src/lib/sla.ts`, `src/lib/billing.ts`, `src/lib/timer.ts`, `src/lib/actions/**`, `src/app/(dashboard)/reports/utilization/**`, `src/app/(dashboard)/reports/sla/**`, `src/components/reports/date-range-filter.tsx`, `src/components/reports/utilization-table.tsx`, `src/components/reports/company-contract-filter.tsx`, `src/components/reports/sla-compliance-summary.tsx`, `package.json`) was touched.

## QA self-check evidence (VerifyQA role, independent re-confirmation)

### Check 1 — Decimal-handling / join-mechanism trace (the CRITICAL finding from plan critique)

Grepped the actual `src/lib/reporting.ts` file directly (not the SUMMARY's claim):

```
$ grep -n 'toNumber' src/lib/reporting.ts
368:    revenueByCompanyId.set(group.companyId, group._sum.total?.toNumber() ?? 0);

$ grep -n 'timeEntry.groupBy\|timeEntry.findMany\|ticket.companyId\|ticket: { select: { companyId' src/lib/reporting.ts
374:  const timeEntries = await db.timeEntry.findMany({
383:      ticket: { select: { companyId: true } },
389:      const entryCompanyId = entry.ticket.companyId;
```

Confirmed by reading the surrounding code (lines 352-395 of `src/lib/reporting.ts`):
- The revenue half is a real `db.invoice.groupBy({ by: ["companyId"], ... _sum: { total: true } })` (valid — `companyId` is a direct field on `Invoice`), and `_sum.total?.toNumber() ?? 0` converts the Prisma `Decimal` to a plain `number` at line 368, before it enters the returned `ProfitabilityRow.billedRevenue` field.
- The hours-invested half is `db.timeEntry.findMany({ ..., select: { durationMinutes: true, ticket: { select: { companyId: true } } } })` at line 374, NOT a `db.timeEntry.groupBy({ by: ["companyId"] })` call. `entry.ticket.companyId` (line 389) is read from the joined `ticket` relation and used to key a JS `Map` that is reduced with a `for` loop (lines 388-395) — this is the correct workaround for the fact that `TimeEntry` has no direct `companyId` column, exactly matching the fix locked in `05-CONTEXT.md`'s "Prisma `groupBy` cross-model limitation" decision.
- No `db.timeEntry.groupBy({ by: ["companyId"] })` (the invalid pattern) appears anywhere in the file — the grep for it returned zero matches.
- `getClientProfitability`'s return type `ProfitabilityRow` (lines 305-310) declares `billedRevenue: number` and `hoursInvested: number` — both plain numbers, confirmed by the `.toNumber()` call above (revenue) and the fact `hoursInvested` is computed as `(minutesByCompanyId.get(id) ?? 0) / 60` (line 418), pure JS arithmetic on numbers, never a `Decimal`.

**Conclusion: the CRITICAL plan-critique fix is confirmed actually present in the real code, independently re-verified by direct grep/read — not merely trusted from 05-01-SUMMARY.md's claim.**

### Check 2 — RBAC gate confirmation

Grepped and read the actual `src/app/(dashboard)/reports/profitability/page.tsx`:

```
$ grep -n 'user\|redirect\|can(' 'src/app/(dashboard)/reports/profitability/page.tsx'
1:import { redirect } from "next/navigation";
29:  const user = await getCurrentUser();
31:  if (!user) {
32:    redirect("/login");
35:  if (!can(user.role, "report:view_all")) {
36:    redirect("/unauthorized");
```

Confirmed:
- `if (!user) redirect("/login")` (lines 31-32) is the literal first check after `getCurrentUser()` (line 29), preceding any `can()` call.
- `can(user.role, "report:view_all")` (line 35) — the literal permission string is `"report:view_all"`, NOT `"report:view_own"`. Verified no other `can(` call exists in the file (single gate, no fallthrough path).
- Both the null-guard and the failing `can()` check use `redirect(...)`, a Next.js function that throws internally to halt rendering — there is no code path after either `redirect()` call in this file that could render partial data; `rows`/`ProfitabilityTable` are only reached after both guards pass.

**Conclusion: the RBAC gate is confirmed correct and redirect-based (not fallthrough), independently re-verified.**

### Check 3 — Terminology confirmation (no "cost"/"profit" as a financial metric)

Case-insensitive grep across both new files for the literal strings "cost" and "profit":

```
$ grep -ni 'cost\|profit' src/components/reports/profitability-table.tsx "src/app/(dashboard)/reports/profitability/page.tsx"
```
Returned 15 lines. Every hit was one of: the type/component name (`ProfitabilityRow`, `ProfitabilityTable`, "profitability" as the report's domain name — not a dollar figure), or text inside the doc comment / visible disclaimer explaining why "cost"/"profit" are deliberately avoided.

Isolated the standalone words "cost" and "profit" (word-boundary, excluding "profitability") to rule out any hidden non-disclaimer usage:

```
$ grep -noiE '\bcost\b' src/components/reports/profitability-table.tsx "src/app/(dashboard)/reports/profitability/page.tsx"
src/components/reports/profitability-table.tsx:25:cost
src/components/reports/profitability-table.tsx:26:cost
src/components/reports/profitability-table.tsx:27:cost
src/components/reports/profitability-table.tsx:64:cost
src/components/reports/profitability-table.tsx:64:cost

$ grep -noiE '\bprofit\b' src/components/reports/profitability-table.tsx "src/app/(dashboard)/reports/profitability/page.tsx"
src/components/reports/profitability-table.tsx:25:profit
src/components/reports/profitability-table.tsx:64:profit
```

All 7 matches are on lines 25-27 (the JSDoc comment explaining the deliberate avoidance) and line 64 (the visible UI disclaimer paragraph explaining the same thing to the end user). Zero matches appear as an actual column label, value, or heading anywhere in the rendered table or page — the rendered columns are literally "Client", "Billed Revenue", "Hours Invested" only (confirmed by reading `profitability-table.tsx` lines 41-44).

**Conclusion: zero disqualifying "cost"/"profit" usage — all matches fall within the explicitly-allowed comment/disclaimer exception.**

## Decisions made

- **No new filter-UI component built for `companyId`/`contractId`.** The plan's `Required interfaces/content structure` section for this page only specifies reusing `DateRangeFilter` and rendering `ProfitabilityTable` — it does not require a company/contract selector UI (unlike 05-03's SLA page, which explicitly built `company-contract-filter.tsx`). `companyId`/`contractId` are still parsed from `searchParams` and passed through to `getClientProfitability` so the filtering capability is functionally present via direct URL query params (e.g. manual navigation or a future enhancement), matching the plan's edge-case requirement that a `contractId` in the URL still reaches the query function correctly — this mirrors 05-03's own precedent of not expanding a component's prop surface beyond what the plan's literal signature specifies.
- **`DateRangeFilter` reused unmodified** from `@/components/reports/date-range-filter` (built by 05-02), per the plan's explicit reuse instruction — not rebuilt.
- **Currency/hours formatting implemented as local helpers** inside `profitability-table.tsx` (`formatCurrency`, `formatHours`), following `invoice-line-table.tsx`'s established `formatCurrency` pattern (`toNumber()`-then-`toLocaleString` with `style: "currency"`) — since `getClientProfitability` already returns plain numbers, no `.toNumber()` call is needed at this layer, only `toLocaleString`.
- **Per-field date fallback** (`from`/`to` validated and defaulted independently), matching 05-02/05-03's established pattern.
- Confirmed via direct read of `src/lib/reporting.ts` and `05-01-SUMMARY.md` that `getClientProfitability(from: string, to: string, companyId?: string, contractId?: string): Promise<ProfitabilityRow[]>` matches the plan's documented (critique-corrected) signature exactly, including the 4th `contractId` parameter — no BLOCKED condition encountered.

## Sidebar nav item

**Confirmed already present from Plan 05-02.** This plan (05-04) read `src/components/nav/app-sidebar.tsx` first, ran the de-dup grep check (`href="/reports/utilization"`), found a match, and left the file completely untouched — no edit made. This is the third and final Wave 2 plan; the sidebar now has exactly one Reports nav entry across all three plans.

## Issues/errors

None. No BLOCKED condition encountered. `getClientProfitability`'s signature and `ProfitabilityRow` shape matched `05-01-SUMMARY.md`/`src/lib/reporting.ts` exactly. `src/lib/permissions.ts` exports `report:view_all` and `can()` as expected. `app-sidebar.tsx` was unambiguously already correct (single exact-string match, confirmed unmodified via `git status --porcelain`). `date-range-filter.tsx` existed as expected from 05-02 and was reused directly. The QA self-check independently re-confirmed all three required evidence points by direct grep/read of the real files, not by trusting prior summaries.
