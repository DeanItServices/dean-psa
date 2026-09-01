# 06-08 Summary — E2E Spec: SLA Tracking

**Status**: Complete

## Files changed
- `e2e/sla-tracking.spec.ts` (new, 138 lines) — one Playwright test covering the full SLA tracking workflow end to end.

No other files were touched. `src/components/tickets/kanban-board.tsx`, `src/components/tickets/sla-badge.tsx`, `src/app/(dashboard)/error.tsx`, `src/app/(dashboard)/loading.tsx` appear modified/untracked in `git status` but are Plan 06-05's sibling-agent changes in this shared worktree, not this plan's.

## What the spec does
1. Logs in as `admin` (see role decision below) via `loginAs(page, "admin")`.
2. Creates a new Company via the real `/clients/new` form (`#name` input, "Create company" button) — asserts the `createCompany` redirect to `/clients/{id}`.
3. Switches to the company detail page's "Contracts" tab and creates a Contract via the real `ContractForm` (`#blockHours`, `#startDate`, `#slaResponseMinutes` = 60, `#slaResolutionMinutes` = 480, "Add contract" button). Waits for the re-rendered `ContractsTab` table to show "60 min" / "480 min" cells as proof the write landed (the form doesn't redirect — it's an in-place server-revalidated table).
4. Creates a Ticket against that company via `/tickets/new` (selects the company by name in the `#companyId` Radix Select, fills subject/description, submits). Asserts the redirect to `/tickets/{id}`.
5. On the ticket detail page, asserts the ticket subject is visible, a badge with text "On track" is visible, and no "No SLA" text is present — confirming `SlaBadge` renders a real, non-"No SLA" status for a ticket whose contract has SLA minutes set.
6. Navigates to `/reports/sla`, asserts the page heading renders, filters by the newly created company via the `CompanyContractFilter`'s `#companyId` select, and asserts the company-scoped contract filter lists the created contract (`/Block Hours \(started/` text) — proving the report page's live DB-backed queries (`db.company.findMany()`, `db.contract.findMany({ where: { companyId } })`) reflect this spec's freshly written data. Also asserts the "Response" and "Resolution" summary card headings render without error.

## Verification
- `test -f e2e/sla-tracking.spec.ts` — pass
- `grep -q 'loginAs' e2e/sla-tracking.spec.ts` — pass
- `grep -q 'test(' e2e/sla-tracking.spec.ts` — pass
- `grep -q 'from "./fixtures"' e2e/sla-tracking.spec.ts` — pass (imports `loginAs` from `./fixtures`)
- `npx tsc --noEmit` — exit 0, zero output (clean type-check across the whole project)
- `git status --porcelain` — confirms only `e2e/sla-tracking.spec.ts` is this plan's change; all other dirty files belong to the concurrent 06-05 sibling agent in this shared worktree.
- Per the plan's explicit instruction, `npx playwright test` was **not** run as part of this plan's verification. Actual browser execution (requires `npx playwright install --with-deps chromium` per 06-04-SUMMARY.md's documented `user_setup` step, plus a running dev server against a seeded local DB) is a follow-up step outside this plan's scope.

## Decisions made

**Company/contract used for guaranteed SLA terms**: the spec creates its own Company (`SLA Test Co {Date.now()}`) and its own Contract (`block_hour` billing, `slaResponseMinutes: 60`, `slaResolutionMinutes: 480`, `startDate` = today) via the real CRM UI rather than depending on seed data. Confirmed via reading `prisma/seed.ts` in full that **zero `Contract` rows are seeded** — there is no pre-existing SLA-bearing contract to rely on, so creating one was required, not optional. This also satisfies the plan's re-runnability requirement (a unique timestamp suffix avoids collisions across repeated runs).

**Role used throughout: `admin`, not `dispatcher`/`finance` as the plan's prose suggested**. Read `src/lib/permissions.ts` in full to confirm the exact role sets:
- `CRM_MANAGE_ROLES = ["sales", "finance", "admin"]` (needed to create the Company + Contract)
- `TICKET_MANAGE_ROLES = ["technician", "dispatcher", "admin"]` (needed to create the Ticket)
- `REPORT_VIEW_ALL_ROLES = ["dispatcher", "finance", "admin"]` (needed for `/reports/sla`)

`dispatcher` (the plan's suggested role for ticket creation) is **not** in `CRM_MANAGE_ROLES` and cannot create the SLA-bearing contract this spec's ticket depends on — attempting to follow the plan's literal role suggestion would have required two separate logins/users just to set up test data, adding complexity with no verification benefit. `admin` is the only role in the intersection of all three role sets, so one login covers company creation, contract creation, ticket creation, and the report view. This is a deliberate, evidence-based deviation from the plan's illustrative role names, not from its intent (the plan says "dispatcher" for ticket creation and "finance ... or any `report:view_all` role" for the report — both are satisfied by `admin`, which is explicitly listed in every relevant role array).

**Exact report-page assertion used**: `getSlaCompliance`'s Met/Breached counters (read in full from `src/lib/reporting.ts`) only count tickets with an *unambiguous final outcome* per leg — met (responded/resolved before deadline) or breached (deadline already passed with no response/resolution). A ticket created moments before the report loads has both deadlines hours in the future and no `firstRespondedAt`/`resolvedAt` yet, so per the function's own "excluded from both" comment it contributes to neither counter — asserting a nonzero Met/Breached count tied to this specific ticket would be non-deterministic (it would only pass if the test happened to run for hours). Instead, the spec asserts on the page's `CompanyContractFilter`, which is fed by a live `db.company.findMany()` / `db.contract.findMany({ where: { companyId } })` query (confirmed by reading `src/app/(dashboard)/reports/sla/page.tsx` in full): selecting the newly created company and confirming its newly created contract appears in the resulting contract dropdown is a deterministic, always-passing proof that the report page's real, live-queried data includes this spec's freshly written rows. The Response/Resolution summary cards are also asserted to render (heading visible) as a smoke check that the page doesn't throw, without asserting on specific counts.

**SLA badge text asserted**: "On track" (exact match), confirmed via `src/lib/sla.ts`'s `getSlaStatus`: `slaResolutionDeadline` is non-null (set from the contract's `slaResolutionMinutes: 480`), `resolvedAt` is null, and `now < deadline - 1hr` (480 minutes = 8 hours out, well past the 1-hour "approaching" window) — so `getSlaStatus` deterministically returns `"on_track"`, which `src/components/tickets/sla-badge.tsx`'s `STATUS_LABEL` map renders as the literal text "On track". Also asserted "No SLA" text is absent. Confirmed via `git diff` that Plan 06-05's concurrent in-progress edit to `sla-badge.tsx` only changes `STATUS_CLASS` (Tailwind color classes for dark-mode/theme-token support) and does not touch `STATUS_LABEL` — the asserted text is unaffected by that sibling change either way.

**Selectors**: all derived from reading live source files during this plan's execution (not guessed): `src/app/(dashboard)/clients/new/page.tsx` + `src/components/crm/company-form.tsx` (`#name`, "Create company"), `src/app/(dashboard)/clients/[companyId]/page.tsx` (`Tabs`/`TabsTrigger` "Contracts") + `src/components/crm/contract-form.tsx` (`#blockHours`, `#startDate`, `#slaResponseMinutes`, `#slaResolutionMinutes`, "Add contract") + `src/components/crm/contracts-tab.tsx` (table cell text format `"{n} min"`), `src/components/tickets/ticket-form.tsx` (`#companyId` Select, `#subject`, `#description`, "Create ticket"), `src/app/(dashboard)/tickets/[ticketId]/page.tsx` (renders `<SlaBadge ticket={ticket} />` directly in the header), `src/app/(dashboard)/reports/sla/page.tsx` + `src/components/reports/company-contract-filter.tsx` (`#companyId` select, contract label format `"{Billing Type} (started {date})"` via `formatContractLabel`) + `src/components/reports/sla-compliance-summary.tsx` ("Response"/"Resolution" card titles).

## Deviations / issues
- Role deviation from the plan's illustrative suggestion (`admin` instead of `dispatcher`/`finance`) — documented above with full rationale; this is a correction to match actual RBAC constraints discovered by reading `permissions.ts`, not a scope reduction.
- No stop-gate was hit: `e2e/fixtures.ts` exports exactly what `06-04-SUMMARY.md` claimed (`ROLE_CREDENTIALS`, `loginAs`); `06-05-SUMMARY.md` did not exist at the time of this plan's execution, so the live `sla-badge.tsx` was read directly per the plan's fallback instruction, and its label text was re-confirmed unaffected by the sibling's later in-flight diff.
- `npx playwright test` was intentionally not run, per the plan's explicit instruction — `npx tsc --noEmit` (exit 0) is the verification bar for this plan. Actual browser-driven execution against a running dev server + seeded/migrated database remains a follow-up step.
