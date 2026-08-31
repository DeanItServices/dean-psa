# Plan 02-02 Summary: Companies & Sites CRUD + Detail Page Shell (CRM Core Wave 2)

## Result
- **Status**: Complete
- **Wave**: 2
- **Agent**: Frontend Developer
- **Completed**: 2026-08-31

## Completed Tasks
1. **Task 1 -- Install zod, add shadcn components, write validations and Server Actions**: Installed `zod`. Ran `npx shadcn@latest add table select tabs textarea -y`, which created `src/components/ui/{table,select,tabs,textarea}.tsx`. Wrote `src/lib/validations/company.ts` (`companySchema`) and `src/lib/validations/site.ts` (`siteSchema`) exactly per the required interfaces. Wrote `src/lib/actions/companies.ts` (`createCompany`, `updateCompany`) and `src/lib/actions/sites.ts` (`createSite`, `updateSite`, `deleteSite`), each Server Action calling `await requireRole(CRM_MANAGE_ROLES)` as its first line before any database write.
2. **Task 2 -- Build company list and create pages**: Wrote `src/app/(dashboard)/clients/page.tsx` (view-gated via `can(user.role, "crm:view")`, redirects to `/login`/`/unauthorized`, renders companies in a shadcn `Table`, "Add Company" button gated by `can(user.role, "crm:manage")`). Wrote `src/components/crm/company-form.tsx` (client component calling `createCompany`). Wrote `src/app/(dashboard)/clients/new/page.tsx` (gated by `requireRole(CRM_MANAGE_ROLES)`, renders `CompanyForm`).
3. **Task 3 -- Build shared tab-type contract, company detail page shell, and placeholder stubs**: Wrote `src/components/crm/tab-types.ts` (`export type CrmTabProps = { companyId: string };`, exactly this and nothing else). Wrote `src/components/crm/site-form.tsx` and `src/components/crm/sites-tab.tsx` (real Sites tab, async Server Component fetching sites directly by `companyId` and rendering `SiteForm`). Wrote the 3 exact placeholder stubs `src/components/crm/contacts-tab.tsx`, `contracts-tab.tsx`, `assets-tab.tsx` per the literal spec text (synchronous, non-async, importing `CrmTabProps`, no extra logic). Wrote `src/app/(dashboard)/clients/[companyId]/page.tsx` (view-gated shell, fetches company + sites via `db.company.findUnique(... include: { sites: true })`, calls `notFound()` if missing, renders a 4-tab shadcn `Tabs` importing all 4 tab components and passing only `companyId={company.id}`).

## Files Modified
- `package.json`, `package-lock.json` -- added `zod` dependency.
- `src/components/ui/table.tsx`, `select.tsx`, `tabs.tsx`, `textarea.tsx` (new) -- shadcn components added via CLI.
- `src/lib/validations/company.ts` (new) -- `companySchema`.
- `src/lib/validations/site.ts` (new) -- `siteSchema`.
- `src/lib/actions/companies.ts` (new) -- `createCompany`, `updateCompany` Server Actions.
- `src/lib/actions/sites.ts` (new) -- `createSite`, `updateSite`, `deleteSite` Server Actions.
- `src/app/(dashboard)/clients/page.tsx` (new) -- company list page.
- `src/app/(dashboard)/clients/new/page.tsx` (new) -- create-company page.
- `src/app/(dashboard)/clients/[companyId]/page.tsx` (new) -- shared tabbed detail page shell.
- `src/components/crm/company-form.tsx` (new) -- create-company client form.
- `src/components/crm/site-form.tsx` (new) -- add-site client form.
- `src/components/crm/sites-tab.tsx` (new) -- real Sites tab (list + add form).
- `src/components/crm/tab-types.ts` (new) -- shared `CrmTabProps` type.
- `src/components/crm/contacts-tab.tsx`, `contracts-tab.tsx`, `assets-tab.tsx` (new) -- exact placeholder stubs for Wave 3.

## Verification Results (actual command outputs)

**Task 1:**
```
$ npm install zod
added 590 packages ... (0 vulnerabilities blocking; 3 high advisories pre-existing/unrelated)

$ npx shadcn@latest add table select tabs textarea -y
✔ Checking registry.
✔ Created 4 files:
  - src\components\ui\table.tsx
  - src\components\ui\select.tsx
  - src\components\ui\tabs.tsx
  - src\components\ui\textarea.tsx

$ grep -q '"zod"' package.json && echo OK
OK
$ test -f src/lib/validations/company.ts && test -f src/lib/actions/companies.ts && grep -q 'requireRole' src/lib/actions/companies.ts && grep -q 'CRM_MANAGE_ROLES' src/lib/actions/companies.ts && echo OK
OK
$ test -f src/lib/validations/site.ts && test -f src/lib/actions/sites.ts && grep -q 'requireRole' src/lib/actions/sites.ts && grep -q 'CRM_MANAGE_ROLES' src/lib/actions/sites.ts && echo OK
OK
```

**Task 2:**
```
$ test -f "src/app/(dashboard)/clients/page.tsx" && grep -q 'crm:view' "src/app/(dashboard)/clients/page.tsx" && echo OK
OK
$ test -f "src/app/(dashboard)/clients/new/page.tsx" && grep -q 'requireRole' ... && grep -q 'CRM_MANAGE_ROLES' ... && echo OK
OK
$ test -f src/components/crm/company-form.tsx && grep -q 'createCompany' src/components/crm/company-form.tsx && echo OK
OK
```

**Task 3:**
```
$ test -f src/components/crm/tab-types.ts && grep -q 'CrmTabProps' src/components/crm/tab-types.ts && echo OK
OK
$ test -f "src/app/(dashboard)/clients/[companyId]/page.tsx" && grep -q 'ContactsTab' ... && grep -q 'ContractsTab' ... && grep -q 'AssetsTab' ... && grep -q 'crm:view' ... && echo OK
OK
$ test -f src/components/crm/sites-tab.tsx && grep -q 'CrmTabProps' src/components/crm/sites-tab.tsx && echo OK
OK
$ test -f src/components/crm/contacts-tab.tsx && grep -q 'ContactsTab' ... && grep -q 'CrmTabProps' ... && echo OK
OK
$ test -f src/components/crm/contracts-tab.tsx && grep -q 'ContractsTab' ... && grep -q 'CrmTabProps' ... && echo OK
OK
$ test -f src/components/crm/assets-tab.tsx && grep -q 'AssetsTab' ... && grep -q 'CrmTabProps' ... && echo OK
OK

$ npx tsc --noEmit
(no output, exit 0)
Note: the pre-existing src/app/layout.tsx LayoutProps error documented in
02-01-SUMMARY.md did NOT reproduce here -- tsc --noEmit is fully clean with
zero errors project-wide, including that file.

$ npm run build
▲ Next.js 16.3.3 (Turbopack)
✓ Compiled successfully in 14.6s
✓ Running TypeScript ... Finished TypeScript in 4.8s
✓ Generating static pages using 11 workers (8/8) in 1638ms
Route (app)
┌ ƒ /
├ ○ /_not-found
├ ƒ /api/auth/[...nextauth]
├ ƒ /clients
├ ƒ /clients/[companyId]
├ ƒ /clients/new
├ ○ /login
└ ƒ /unauthorized
(exit 0)
```

## Verification Commands Table

| Command | Exit Code | Result |
|---|---|---|
| `npm install zod` | 0 | Pass |
| `npx shadcn@latest add table select tabs textarea -y` | 0 | Pass -- 4 files created |
| `grep -q '"zod"' package.json` | 0 | Pass |
| `test -f src/components/ui/table.tsx` | 0 | Pass |
| `test -f src/components/ui/select.tsx` | 0 | Pass |
| `test -f src/components/ui/tabs.tsx` | 0 | Pass |
| `test -f src/lib/validations/company.ts` | 0 | Pass |
| `test -f src/lib/actions/companies.ts` | 0 | Pass |
| `grep -q 'requireRole' src/lib/actions/companies.ts` | 0 | Pass |
| `grep -q 'CRM_MANAGE_ROLES' src/lib/actions/companies.ts` | 0 | Pass |
| `test -f src/lib/validations/site.ts` | 0 | Pass |
| `test -f src/lib/actions/sites.ts` | 0 | Pass |
| `grep -q 'requireRole' src/lib/actions/sites.ts` | 0 | Pass |
| `grep -q 'CRM_MANAGE_ROLES' src/lib/actions/sites.ts` | 0 | Pass |
| `test -f "src/app/(dashboard)/clients/page.tsx"` | 0 | Pass |
| `grep -q 'crm:view' "src/app/(dashboard)/clients/page.tsx"` | 0 | Pass |
| `test -f "src/app/(dashboard)/clients/new/page.tsx"` | 0 | Pass |
| `grep -q 'requireRole' "src/app/(dashboard)/clients/new/page.tsx"` | 0 | Pass |
| `grep -q 'CRM_MANAGE_ROLES' "src/app/(dashboard)/clients/new/page.tsx"` | 0 | Pass |
| `test -f src/components/crm/company-form.tsx` | 0 | Pass |
| `grep -q 'createCompany' src/components/crm/company-form.tsx` | 0 | Pass |
| `test -f src/components/crm/tab-types.ts` | 0 | Pass |
| `grep -q 'CrmTabProps' src/components/crm/tab-types.ts` | 0 | Pass |
| `test -f "src/app/(dashboard)/clients/[companyId]/page.tsx"` | 0 | Pass |
| `grep -q 'ContactsTab' .../[companyId]/page.tsx` | 0 | Pass |
| `grep -q 'ContractsTab' .../[companyId]/page.tsx` | 0 | Pass |
| `grep -q 'AssetsTab' .../[companyId]/page.tsx` | 0 | Pass |
| `grep -q 'crm:view' .../[companyId]/page.tsx` | 0 | Pass |
| `test -f src/components/crm/sites-tab.tsx` | 0 | Pass |
| `grep -q 'CrmTabProps' src/components/crm/sites-tab.tsx` | 0 | Pass |
| `test -f src/components/crm/contacts-tab.tsx` | 0 | Pass |
| `grep -q 'ContactsTab' src/components/crm/contacts-tab.tsx` | 0 | Pass |
| `grep -q 'CrmTabProps' src/components/crm/contacts-tab.tsx` | 0 | Pass |
| `test -f src/components/crm/contracts-tab.tsx` | 0 | Pass |
| `grep -q 'ContractsTab' src/components/crm/contracts-tab.tsx` | 0 | Pass |
| `grep -q 'CrmTabProps' src/components/crm/contracts-tab.tsx` | 0 | Pass |
| `test -f src/components/crm/assets-tab.tsx` | 0 | Pass |
| `grep -q 'AssetsTab' src/components/crm/assets-tab.tsx` | 0 | Pass |
| `grep -q 'CrmTabProps' src/components/crm/assets-tab.tsx` | 0 | Pass |
| `npx tsc --noEmit` | 0 | Pass -- zero errors, including the pre-existing layout.tsx issue from 02-01 |
| `npm run build` | 0 | Pass -- all 3 new routes (`/clients`, `/clients/[companyId]`, `/clients/new`) compiled and listed |

## Key Decisions
1. **Read the Next.js docs at `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md` before writing the detail page**, per AGENTS.md's instruction that this Next.js version has breaking changes from training data. Confirmed `params` is a `Promise<{ companyId: string }>` in this version (Next.js 16.3.3) and must be awaited -- used `const { companyId } = await params;` in `CompanyDetailPage`, not the synchronous-access pattern from older Next.js versions.
2. **`SitesTab` is an async Server Component that fetches sites itself** rather than receiving them as a prop from the parent page, even though the parent page already fetches `company.sites` via `include: { sites: true }`. This keeps `CrmTabProps` strictly limited to `{ companyId: string }` with no second prop, per the Wave 3 parallel-safety contract's explicit rule ("no plan may add a second prop to any tab component"). The minor cost is one extra `db.site.findMany` query; the benefit is exact compliance with the shared type contract every Wave 3 plan will be typechecked against.
3. **Followed the existing `login/page.tsx` pattern** for `CompanyForm`/`SiteForm`: client-side `useState` per field + calling the Server Action directly with a manually-constructed `FormData`, rather than `<form action={...}>`. This matches the one existing precedent in the codebase for Server-Action-backed forms rather than introducing a second pattern.
4. **`CompanyForm`'s catch block re-throws Next.js's internal redirect signal** (detected via `err.digest.startsWith("NEXT_REDIRECT")`) instead of swallowing it as a generic error, since `createCompany` calls `redirect()` on success and Next.js implements that via a thrown error with a special digest that must propagate to the framework's router, not be caught as an application error.
5. **`isPrimary` on `SiteForm` uses a native `<input type="checkbox">`** rather than shadcn `Select`, since it's a boolean, not an enumerable choice -- `select` was still installed per the plan's task list (for potential future billing-type dropdowns in Contracts, Wave 3) but is not consumed by this plan's own forms.
6. **Did not implement delete-confirmation UX for `deleteSite`** -- the action exists and enforces RBAC, but no UI wires it up yet (not required by this plan's explicit page/tab specs, which only require SitesTab to list sites and include an add form). Flagged here rather than silently omitted.

## Issues Encountered
- **Pre-existing `layout.tsx` `LayoutProps` tsc error (noted in 02-01-SUMMARY.md) did not reproduce.** 02-01 reported `npx tsc --noEmit` failing on `src/app/layout.tsx(20,50): error TS2304: Cannot find name 'LayoutProps'` due to missing `.next/types`. Running `npx tsc --noEmit` in this plan produced zero errors, including for that file. Root cause of the resolution: this plan's `npm install zod` step and/or an intervening `next build` (possibly run by tooling between plans, or the `.next/types` directory being generated as a side effect of some earlier command in this session) evidently generated the missing `.next/types/routes.d.ts`. Not investigated further since it is a strict improvement (fewer errors, not more) and outside this plan's write scope to have caused deliberately. `npm run build` also succeeded outright, so no verification gap exists here -- both `tsc --noEmit` and `npm run build` are genuinely clean, not filtered/excused.

## Escalations
None. No stop-gate condition was hit: the Prisma schema, permissions, and session helpers all matched 02-01's documented shapes exactly; `components.json` existed; `npx shadcn@latest add table select tabs textarea -y` succeeded without error.

## Handoff Context

**Key outputs for Wave 3 plans (02-03 Contacts, 02-04 Contracts, 02-05 Assets):**
- `src/components/crm/tab-types.ts` exports `export type CrmTabProps = { companyId: string };` -- import this exact type in each Wave 3 tab component; do not re-declare the prop type inline, and do not add a second prop (the parent page at `src/app/(dashboard)/clients/[companyId]/page.tsx` passes only `companyId={company.id}` to each of the 4 tabs and is out of scope for Wave 3 plans to edit).
- Placeholder stubs exist at `src/components/crm/contacts-tab.tsx`, `contracts-tab.tsx`, `assets-tab.tsx`, each a synchronous, non-async function component. Wave 3 plans overwrite the body of their one owned file; replacing a sync stub with an `async` Server Component is explicitly permitted (forward-compatible signature evolution) -- see `sites-tab.tsx` in this plan for a working example of that exact pattern (async Server Component, `export async function SitesTab(props: CrmTabProps)`, self-fetches via `db` rather than receiving fetched data as a prop).
- `src/lib/actions/companies.ts` and `src/lib/actions/sites.ts` establish the Server Action conventions for this phase: `"use server"` at the top of the file, `await requireRole(CRM_MANAGE_ROLES)` (imported from `@/lib/permissions`) as the literal first line of every mutating action, `zod` `.safeParse()` for validation returning `{ error: string }` on failure, `db` from `@/lib/db` for all queries, and either `redirect()` (create-and-navigate flows) or `revalidatePath()` + `{ success: true }` (in-place edit/list flows) on success. Wave 3 plans' `contacts.ts`/`contracts.ts`/`assets.ts` action files should follow this same shape for consistency.
- `src/components/crm/company-form.tsx` and `site-form.tsx` establish the form conventions: `"use client"`, per-field `useState`, manually-built `FormData` passed directly to the imported Server Action (not `<form action={fn}>`), inline `role="alert"` error text using `text-destructive`, using shadcn `Input`/`Label`/`Button` exactly as styled in `src/app/(auth)/login/page.tsx`.
- `select` and `textarea` shadcn components are installed (via this plan's Task 1) but unused by Companies/Sites -- available for Wave 3's Contracts tab (`billingType` enum dropdown) and Assets tab (`notes` field) without needing to re-run `shadcn add`.
- Next.js 16.3.3 dynamic route `params` are a `Promise` -- any Wave 3 plan adding its own dynamic segment routes (none currently planned) must `await params`.

**Open questions / notes for future plans or the user:**
- No delete-confirmation UI exists for `deleteSite` (the Server Action is implemented and RBAC-gated, but nothing in `SitesTab` currently calls it). If Wave 3 or a later phase wants site deletion exposed in the UI, that's a small addition to `sites-tab.tsx`, which remains owned by this plan/phase (not Wave 3's file-ownership scope) -- flag to the user or a later phase rather than having a Wave 3 plan edit `sites-tab.tsx` directly.
- No dedicated `/clients/[companyId]/edit` page was built for `updateCompany` -- the Server Action exists (`updateCompany(id, formData)` returning `{ success: true }` or `{ error }`) per the plan's required interface, but no UI currently calls it. The plan's scope only required the action to exist with the correct signature and RBAC gate, not a wired-up edit form; this is a legitimate gap for the phase owner to decide whether to close in a later plan.
- The `dean-psa2-db-1` shared Postgres container (documented in 02-01-SUMMARY.md) remains the database this plan's `npm run build`/type-checking ran against implicitly via the generated Prisma Client -- no new migration or schema change was needed for this plan.

## Requirements Covered
- Client companies & multi-site records -- `/clients` list, `/clients/new` create, `/clients/[companyId]` detail-with-Sites-tab, `createCompany`/`updateCompany`/`createSite`/`updateSite`/`deleteSite` Server Actions all implemented and RBAC-gated.
- Shared company detail page shell for Wave 3 -- `tab-types.ts` contract + 4-tab shell + 3 placeholder stubs, unblocking parallel execution of Plans 02-03/02-04/02-05.
