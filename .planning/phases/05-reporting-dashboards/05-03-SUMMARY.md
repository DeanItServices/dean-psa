# Plan 05-03 Summary — SLA Compliance Report

## Status: Complete

## Files changed
- `src/components/reports/company-contract-filter.tsx` (new) — `"use client"` presentational component. Props exactly as specified: `{ companies: { id: string; name: string }[]; selectedCompanyId?: string; selectedContractId?: string; basePath: string }`. Company `<select>` built with shadcn `Select`, using the codebase's established `"none"` sentinel convention (confirmed from `src/components/tickets/ticket-form.tsx`'s `NONE_VALUE` pattern) since Radix `SelectItem` cannot use an empty-string value. On change, navigates via `useRouter().push`, reading the current URL's existing `from`/`to` query params via `window.location.search` and preserving them while updating `companyId` (and clearing `contractId`, since a contract belongs to a single company and is invalidated by a company change).
- `src/components/reports/sla-compliance-summary.tsx` (new) — Props `{ result: SlaComplianceResult }`, type imported from `@/lib/reporting`. Renders two `Card`-based summary blocks (Response, Resolution), each showing Met count, Breached count, and Compliance %. When `responseCompliancePct`/`resolutionCompliancePct` is `null`, renders an explicit "No data in this range" message (never "0%" or blank). Terminology ("Met"/"Breached") matches `src/components/tickets/sla-badge.tsx`'s existing status labels.
- `src/app/(dashboard)/reports/sla/page.tsx` (new) — async Server Component. `searchParams` typed as `Promise<{ from?: string; to?: string; companyId?: string; contractId?: string }>`, awaited. First two logic lines: `getCurrentUser()` then `if (!user) redirect("/login")`, preceding any `can()` call (matching `invoices/page.tsx`'s exact pattern). Then `if (!can(user.role, "report:view_all")) redirect("/unauthorized")` — `report:view_own` alone does not grant access to this page. `from`/`to` parsed as raw strings with a `/^\d{4}-\d{2}-\d{2}$/` shape check, falling back per-field to `getCurrentMonthRange()`; no `Date` construction in this file. `companyId`/`contractId` parsed as optional raw strings. Fetches company list via `db.company.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })`. Calls `getSlaCompliance(from, to, companyId, contractId)`. Renders the reused `DateRangeFilter` (from 05-02) + `CompanyContractFilter` + `SlaComplianceSummary`.
- `src/components/nav/app-sidebar.tsx` — **NOT modified.** Confirmed via `grep -q 'href="/reports/utilization"' src/components/nav/app-sidebar.tsx` (matched) that Plan 05-02 already added the Reports nav item. File left completely untouched, per the plan's conditional-edit instruction. Confirmed via `git status --porcelain` that the file does not appear in the changed-files list.

## Decisions made

- **`date-range-filter.tsx` reused, not rebuilt.** Confirmed it already exists (created by 05-02) with props `{ from: string; to: string; basePath: string }` — imported directly into the SLA page rather than building a second date-range control, per the plan's explicit instruction.
- **`CompanyContractFilter`'s literal prop signature has no `contracts` list**, even though the plan's prose mentions "if a company is selected... contracts list is passed in or fetched by the parent." The plan's `Required interfaces/content structure` section states the props exactly as `{ companies, selectedCompanyId?, selectedContractId?, basePath }` with no `contracts` prop. Followed the literal, authoritative prop signature: the component renders the company `<select>` and preserves any existing `contractId` query param through navigation (clearing it on company change, since a contract belongs to a single company), but does not render a separate contract-selection UI element, since no contract data prop exists per the plan's own signature. A `contractId` in the URL (e.g. set manually or by a future enhancement) is still passed through to `getSlaCompliance` correctly by the page.
- **`buildParams` reads `window.location.search`** at click-time (client-side) rather than being passed `from`/`to` as props, since the plan's prop signature for `CompanyContractFilter` does not include `from`/`to` — this still satisfies "navigates ... preserving the existing `from`/`to` params" without expanding the component's prop surface beyond what's specified.
- **`Card` component used for the two SLA summary blocks** (Response/Resolution) — a natural fit for "two summary blocks" and already an installed shadcn primitive (`src/components/ui/card.tsx`), no new dependency.
- Confirmed via direct read of `src/lib/reporting.ts` that `getSlaCompliance(from: string, to: string, companyId?: string, contractId?: string): Promise<SlaComplianceResult>` matches 05-01-SUMMARY.md's documented signature exactly — no BLOCKED condition encountered.
- Confirmed via `05-02-SUMMARY.md` that Plan 05-02 was the first Wave 2 plan to touch `app-sidebar.tsx` and already added the exact locked `<li>` block — this plan correctly found it present and skipped re-adding it.

## Verification commands and outputs

```
$ npx tsc --noEmit
(no output — exit 0)

$ test -f 'src/app/(dashboard)/reports/sla/page.tsx' && echo PASS
PASS

$ grep -q 'report:view_all' 'src/app/(dashboard)/reports/sla/page.tsx' && echo PASS
PASS

$ grep -q 'getSlaCompliance' 'src/app/(dashboard)/reports/sla/page.tsx' && echo PASS
PASS

$ test -f src/components/reports/sla-compliance-summary.tsx && echo PASS
PASS

$ test -f src/components/reports/company-contract-filter.tsx && grep -q '"use client"' src/components/reports/company-contract-filter.tsx && echo PASS
PASS

$ grep -q 'href="/reports/utilization"' src/components/nav/app-sidebar.tsx && echo PASS
PASS
```

### Scope check
```
$ git status --porcelain
?? src/app/(dashboard)/reports/sla/
?? src/components/reports/company-contract-filter.tsx
?? src/components/reports/sla-compliance-summary.tsx
```
Only the three new files appear — `src/components/nav/app-sidebar.tsx` does NOT appear in git status, confirming it was left completely untouched. No forbidden-target file (`prisma/schema.prisma`, `prisma/migrations/**`, `src/lib/permissions.ts`, `src/lib/reporting.ts`, `src/lib/sla.ts`, `src/lib/billing.ts`, `src/lib/timer.ts`, `src/lib/actions/**`, `src/app/(dashboard)/reports/utilization/**`, `src/app/(dashboard)/reports/profitability/**`, `src/components/reports/date-range-filter.tsx`, `src/components/reports/utilization-table.tsx`, `package.json`) was touched.

## Sidebar nav item

**Confirmed already present from Plan 05-02.** This plan (05-03) read `src/components/nav/app-sidebar.tsx` first, ran the de-dup grep check (`href="/reports/utilization"`), found a match, and left the file completely untouched — no edit made.

## Issues/errors

None. No BLOCKED condition encountered. `getSlaCompliance`'s signature and `SlaComplianceResult` shape matched `05-01-SUMMARY.md`/`src/lib/reporting.ts` exactly. `src/lib/permissions.ts` exports `report:view_all` and `can()` as expected. `app-sidebar.tsx`'s structure was unambiguous (Reports link already present, single exact-string match). `date-range-filter.tsx` existed as expected from 05-02 and was reused directly.
