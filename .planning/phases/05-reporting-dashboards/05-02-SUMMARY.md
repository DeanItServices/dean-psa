# Plan 05-02 Summary — Technician Utilization Dashboard

## Status: Complete

## Files changed
- `src/components/reports/date-range-filter.tsx` (new) — `"use client"` shared date-range filter bar. Props `{ from: string; to: string; basePath: string }`. Two native `<input type="date">` elements (via shadcn `Input`/`Label`) plus an "Apply" button; on submit, calls `useRouter().push(\`${basePath}?from=${fromValue}&to=${toValue}\`)`. Local `useState` mirrors the `from`/`to` props so edits before Apply don't mutate the URL prematurely. Built as a form with `onSubmit` (not a raw button `onClick`) for standard keyboard/Enter-key submission accessibility.
- `src/components/reports/utilization-table.tsx` (new) — renders `UtilizationRow[]` (type imported from `@/lib/reporting`). Columns: Technician, Minutes Logged (formatted via a local `formatMinutesAsHours` helper as `"Xh Ym"`), Capacity (same formatter), Utilization % (`toFixed(1)`). Empty-state row uses `colSpan={COLUMN_COUNT}` (`COLUMN_COUNT = 4`, matching the actual column count). A visible `<p>` disclaimer below the table states capacity is a fixed 8hr/weekday estimate, not a real per-technician schedule — rendered in the UI, not just a code comment.
- `src/app/(dashboard)/reports/utilization/page.tsx` (new) — async Server Component. `searchParams` typed as `Promise<{ from?: string; to?: string }>` and awaited. First two logic lines: `getCurrentUser()` then `if (!user) redirect("/login")`, preceding any `can()` call. Then `if (!can(user.role, "report:view_own")) redirect("/unauthorized")`. `from`/`to` parsed as raw strings with a `/^\d{4}-\d{2}-\d{2}$/` shape check; falls back to `getCurrentMonthRange()` per-field if absent or malformed — no `Date` construction in this file. Branches on `can(user.role, "report:view_all")`: cross-technician calls `getTechnicianUtilization(from, to)`; self-scoped calls `getTechnicianUtilization(from, to, user.id)` (always passes `user.id`, never client-filters a cross-technician result). Renders `DateRangeFilter` + `UtilizationTable` with a heading that switches between "My Utilization" and "Technician Utilization".
- `src/components/nav/app-sidebar.tsx` (append-only edit) — added the exact locked "Reports" `<li>` block from `05-CONTEXT.md`'s "Sidebar nav single-source-of-truth" decision, verbatim, inserted immediately after the Invoices `<li>` and before the Admin `<li>`. **This plan (05-02) was confirmed as the first Wave 2 plan to touch this file** — `grep -q 'href="/reports/utilization"' src/components/nav/app-sidebar.tsx` returned no match before this edit, so the block was added (not skipped). No other line in the file was changed.

## Verification commands and outputs

```
$ npx tsc --noEmit
(no output — exit 0)

$ test -f 'src/app/(dashboard)/reports/utilization/page.tsx' && echo PASS
PASS

$ grep -q 'report:view_own' 'src/app/(dashboard)/reports/utilization/page.tsx' && echo PASS
PASS

$ grep -q 'getTechnicianUtilization' 'src/app/(dashboard)/reports/utilization/page.tsx' && echo PASS
PASS

$ test -f src/components/reports/date-range-filter.tsx && grep -q '"use client"' src/components/reports/date-range-filter.tsx && echo PASS
PASS

$ test -f src/components/reports/utilization-table.tsx && echo PASS
PASS

$ grep -q 'href="/reports/utilization"' src/components/nav/app-sidebar.tsx && echo PASS
PASS
```

### Scope check
```
$ git status --porcelain
 M src/components/nav/app-sidebar.tsx
?? src/app/(dashboard)/reports/
?? src/components/reports/
```
Only the four planned write targets were touched (`src/app/(dashboard)/reports/utilization/page.tsx`, `src/components/reports/date-range-filter.tsx`, `src/components/reports/utilization-table.tsx`, `src/components/nav/app-sidebar.tsx`). No forbidden-target file (`prisma/schema.prisma`, `prisma/migrations/**`, `src/lib/permissions.ts`, `src/lib/reporting.ts`, `src/lib/sla.ts`, `src/lib/billing.ts`, `src/lib/timer.ts`, `src/lib/actions/**`, `src/app/(dashboard)/reports/sla/**`, `src/app/(dashboard)/reports/profitability/**`, `package.json`) was touched.

## Decisions made

- **`DateRangeFilter` uses a `<form onSubmit>` wrapper** rather than a bare button `onClick` handler — gives free keyboard/Enter-key submission and matches the accessible-form pattern used elsewhere in the codebase (e.g. `ticket-form.tsx`), without adding any new dependency.
- **Local `useState` mirrors of the `from`/`to` props** in `DateRangeFilter` so a user can edit both date inputs before clicking Apply without each keystroke re-navigating; navigation only happens on submit, matching the plan's "Apply button ... navigates" specification.
- **Minutes-to-hours formatting** (`formatMinutesAsHours`) implemented as a small local helper inside `utilization-table.tsx` rather than in `reporting.ts` (which is read-only/forbidden for this plan) — purely a presentation-layer concern, consistent with the plan's ownership boundaries.
- **Per-field date fallback**: `from` and `to` are validated and defaulted independently (each falls back to its own `getCurrentMonthRange()` field if missing/malformed) rather than requiring both-or-neither, so a partially malformed query string (e.g. only `to` present) still produces a sane range instead of failing closed.
- Confirmed via direct read of `src/lib/reporting.ts` and `05-01-SUMMARY.md` that `getTechnicianUtilization(from: string, to: string, userId?: string): Promise<UtilizationRow[]>` matches the plan's documented signature exactly — no BLOCKED condition encountered.

## Sidebar nav item

Confirmed: **Plan 05-02 added the "Reports" nav item** (first Wave 2 plan in execution order to touch `src/components/nav/app-sidebar.tsx`). Plans 05-03/05-04 should find `href="/reports/utilization"` already present and skip re-adding it per `05-CONTEXT.md`'s locked de-dup instruction.

## Issues/errors
None. No BLOCKED condition encountered — all expected exports/signatures in `src/lib/reporting.ts` and `src/lib/permissions.ts` matched documentation exactly, and `app-sidebar.tsx`'s structure matched the documented Phase 4 shape with no ambiguity about insertion point.
