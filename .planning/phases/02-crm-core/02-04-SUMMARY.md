# Plan 02-04 Summary: Contracts CRUD (billing type + SLA fields)

## Result
- **Status**: Complete
- **Wave**: 3
- **Agent**: Backend Architect
- **Completed**: 2026-08-31

## Completed Tasks
1. **Task 1 -- Contract discriminated-union validation schema**: Wrote `src/lib/validations/contract.ts` with `contractSchema = z.discriminatedUnion("billingType", [...])`, exactly 3 branches (`block_hour`, `flat_fee`, `hourly_breakfix`), each requiring only its own type-specific field (`blockHours: number.int().positive()`, `flatFeeAmount: number.positive()`, `hourlyRate: number.positive()` respectively) plus shared `baseFields` (`startDate` required, `endDate`/`slaResponseMinutes`/`slaResolutionMinutes` all optional).
2. **Task 2 -- Contract Server Actions**: Wrote `src/lib/actions/contracts.ts` (`"use server"`) exporting `createContract(companyId, formData)`, `updateContract(id, formData)`, `deleteContract(id)`. Each calls `await requireRole(CRM_MANAGE_ROLES)` (imported from `@/lib/permissions`) as its first line. FormData is parsed via a `parseContractFormData` helper that reads only the field relevant to the submitted `billingType`, then validated with `contractSchema.safeParse`. On success, `toContractData` maps the validated branch to Prisma columns, explicitly nulling the two billing-type columns that don't apply. `update`/`delete` catch Prisma's `P2025` (`isPrismaNotFound` helper checking `Prisma.PrismaClientKnownRequestError` + code) and return `{ error: "Contract not found" }` instead of throwing.
3. **Task 3 -- Replace ContractsTab placeholder; add ContractForm**: Wrote `src/components/crm/contract-form.tsx` (`"use client"`) with a shadcn `Select` for billing type (3 options: Block Hours / Flat Fee / Hourly Break-Fix), one conditionally-rendered amount/rate `Input` matching the selected type, date inputs for start/end, number inputs for SLA response/resolution minutes. Switching billing type via `handleBillingTypeChange` clears all 3 type-specific state fields so a stale value from a previously-selected type is never submitted (only the field matching the current `billingType` is appended to `FormData` in `handleSubmit` regardless). Replaced `src/components/crm/contracts-tab.tsx`'s body: now an `async function ContractsTab(props: CrmTabProps)` (imports `CrmTabProps` from `./tab-types`, unchanged import path) that fetches the company's contracts via `db.contract.findMany`, renders them in a shadcn `Table` (billing type label, the one relevant amount/rate value, SLA response/resolution, start/end dates), and renders `ContractForm` below.

## Files Modified
- `src/lib/validations/contract.ts` (new) -- `contractSchema` discriminated union.
- `src/lib/actions/contracts.ts` (new) -- `createContract`, `updateContract`, `deleteContract` Server Actions.
- `src/components/crm/contract-form.tsx` (new) -- add-contract client form with conditional billing-type field rendering.
- `src/components/crm/contracts-tab.tsx` (replaced placeholder body) -- real Contracts tab (list + add form).

No other files were touched. Sibling plans (02-03 Contacts, 02-05 Assets) were confirmed via `git status` to have independently modified `contacts-tab.tsx`, `assets-tab.tsx`, `app-sidebar.tsx`, and their own action/validation files concurrently -- none of those were read for content or edited by this plan.

## Verification Results (actual command outputs)

**Task 1:**
```
$ test -f src/lib/validations/contract.ts && echo OK
OK
$ grep -q 'discriminatedUnion' src/lib/validations/contract.ts && echo OK
OK
$ grep -q 'block_hour' ... && grep -q 'flat_fee' ... && grep -q 'hourly_breakfix' ... && echo OK
OK
```

**Task 2:**
```
$ test -f src/lib/actions/contracts.ts && echo OK
OK
$ grep -q 'requireRole' ... && grep -q 'CRM_MANAGE_ROLES' ... && echo OK
OK
$ grep -q 'createContract' ... && grep -q 'updateContract' ... && grep -q 'deleteContract' ... && echo OK
OK
$ grep -q 'block_hour' ... && grep -q 'flat_fee' ... && grep -q 'hourly_breakfix' ... && echo OK
OK
```

**Task 3:**
```
$ grep -q 'export function ContractsTab' src/components/crm/contracts-tab.tsx
FAIL (exit 1) -- see "Deviation" note below; actual signature is
`export async function ContractsTab(props: CrmTabProps)`.
$ grep -q 'CrmTabProps' src/components/crm/contracts-tab.tsx && echo OK
OK
$ grep -c 'Coming soon' src/components/crm/contracts-tab.tsx | xargs test 0 -eq && echo OK
OK
$ test -f src/components/crm/contract-form.tsx && grep -q 'createContract' src/components/crm/contract-form.tsx && echo OK
OK
$ npx tsc --noEmit
(no output, exit 0)
$ npm run build
▲ Next.js 16.3.3 (Turbopack)
✓ Compiled successfully in 897ms
✓ Running TypeScript ... Finished TypeScript in 4.0s
✓ Generating static pages using 11 workers (8/8) in 1914ms
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

**Deviation note (Task 3 literal grep vs. context-permitted signature evolution):**
The plan's literal verification line `grep -q 'export function ContractsTab'` (without "async")
does not match `export async function ContractsTab(...)` because grep does substring matching
and "async " sits between "export" and "function" in the actual source. However:
- 02-CONTEXT.md's Wave 3 parallel-safety contract explicitly states the stub is "synchronous
  specifically so Wave 3 plans replacing them with `async` Server Components is an explicitly
  permitted, forward-compatible change."
- The sibling Sites tab (`sites-tab.tsx`, written by 02-02) already uses this exact pattern:
  `export async function SitesTab(props: CrmTabProps)`.
- `ContractsTab` must be `async` because it calls `await db.contract.findMany(...)` directly
  (an async Server Component, matching the established SitesTab precedent) -- a synchronous
  function cannot await a database call in its own body.
- The type-checked contract (`CrmTabProps` imported from `./tab-types`, verified by
  `npx tsc --noEmit` exiting 0) is what the plan calls the actual compiler-enforced guarantee;
  the prose grep is a secondary, non-authoritative check that was not updated to account for
  the async evolution it itself permits.
This is treated as a plan-verification-script gap, not an implementation defect. The export
signature `ContractsTab(props: CrmTabProps)` -- the part of the placeholder's shape that
matters for the shared contract -- is fully preserved; only the sync/async qualifier changed,
exactly as 02-CONTEXT.md anticipated.

**QA self-review: runtime trace of all 3 billing-type branches (not just grep)**
Per this dispatch's explicit QA-verification instruction, ran the actual `contractSchema`
(imported live via `npx tsx`, not re-typed/re-derived) against 15 hand-built payloads covering:
each type valid with only its own field; each type rejecting when its own field is missing;
each type rejecting when only ANOTHER type's field is supplied instead of its own (the core
"does the union actually enforce mutual exclusivity" property); optional-SLA-fields-absent
allowed; and an unrecognized `billingType` literal rejected by the discriminator itself.

```
PASS :: block_hour: valid with blockHours only :: success=true
PASS :: flat_fee: valid with flatFeeAmount only :: success=true
PASS :: hourly_breakfix: valid with hourlyRate only :: success=true
PASS :: block_hour: REJECT missing blockHours :: success=false
PASS :: flat_fee: REJECT missing flatFeeAmount :: success=false
PASS :: hourly_breakfix: REJECT missing hourlyRate :: success=false
PASS :: block_hour: REJECT when only flatFeeAmount supplied (wrong field for type) :: success=false
PASS :: block_hour: REJECT when only hourlyRate supplied (wrong field for type) :: success=false
PASS :: flat_fee: REJECT when only blockHours supplied (wrong field for type) :: success=false
PASS :: flat_fee: REJECT when only hourlyRate supplied (wrong field for type) :: success=false
PASS :: hourly_breakfix: REJECT when only blockHours supplied (wrong field for type) :: success=false
PASS :: hourly_breakfix: REJECT when only flatFeeAmount supplied (wrong field for type) :: success=false
PASS :: block_hour: valid with no SLA fields set (both optional) :: success=true
PASS :: block_hour: valid with SLA fields set :: success=true
PASS :: REJECT unknown billingType literal :: success=false

15/15 passed
```
The scratch script (`scripts-qa-tmp-contract-check.ts`, at repo root, outside this plan's write
targets) was deleted immediately after this run; `git status --porcelain` confirms it left no
trace and that only the 4 write-target files show as changed by this plan.

## Verification Commands Table

| Command | Exit Code | Result |
|---|---|---|
| `test -f src/lib/validations/contract.ts` | 0 | Pass |
| `grep -q 'discriminatedUnion' src/lib/validations/contract.ts` | 0 | Pass |
| `grep -q 'block_hour' src/lib/validations/contract.ts` | 0 | Pass |
| `grep -q 'flat_fee' src/lib/validations/contract.ts` | 0 | Pass |
| `grep -q 'hourly_breakfix' src/lib/validations/contract.ts` | 0 | Pass |
| `test -f src/lib/actions/contracts.ts` | 0 | Pass |
| `grep -q 'requireRole' src/lib/actions/contracts.ts` | 0 | Pass |
| `grep -q 'CRM_MANAGE_ROLES' src/lib/actions/contracts.ts` | 0 | Pass |
| `grep -q 'createContract' src/lib/actions/contracts.ts` | 0 | Pass |
| `grep -q 'updateContract' src/lib/actions/contracts.ts` | 0 | Pass |
| `grep -q 'deleteContract' src/lib/actions/contracts.ts` | 0 | Pass |
| `grep -q 'block_hour' src/lib/actions/contracts.ts` | 0 | Pass |
| `grep -q 'flat_fee' src/lib/actions/contracts.ts` | 0 | Pass |
| `grep -q 'hourly_breakfix' src/lib/actions/contracts.ts` | 0 | Pass |
| `grep -q 'export function ContractsTab' src/components/crm/contracts-tab.tsx` | 1 | Fail -- see Deviation note; actual is `export async function ContractsTab`, a context-permitted evolution not reflected in this literal grep |
| `grep -q 'CrmTabProps' src/components/crm/contracts-tab.tsx` | 0 | Pass |
| `grep -c 'Coming soon' src/components/crm/contracts-tab.tsx \| xargs test 0 -eq` | 0 | Pass |
| `test -f src/components/crm/contract-form.tsx` | 0 | Pass |
| `grep -q 'createContract' src/components/crm/contract-form.tsx` | 0 | Pass |
| `npx tsc --noEmit` | 0 | Pass |
| `npm run build` | 0 | Pass -- all routes compiled, including `/clients/[companyId]` |
| Runtime QA trace (15 cases via `npx tsx`) | 0 | Pass -- 15/15 |

## Key Decisions
1. **`ContractsTab` is an async Server Component that self-fetches contracts**, following the exact precedent `SitesTab` set in Plan 02-02 (`db.contract.findMany({ where: { companyId } })` inside the component body), rather than receiving contracts as a prop. This keeps `CrmTabProps` strictly `{ companyId: string }` per the Wave 3 shared-contract rule that no tab component may add a second prop.
2. **Discriminated union field mapping to Prisma columns is centralized in `toContractData`** in `contracts.ts`, which explicitly sets the two non-applicable billing-type columns to `null` rather than leaving them `undefined`. This guarantees that switching a contract's billing type via `updateContract` correctly clears the previous type's now-stale value in the database, not just on the client -- an edge case the plan's client-side "clear on switch" requirement covers for the form, but which also needed a server-side guarantee for `updateContract` (create always starts from a clean slate, but update on an existing record could otherwise leave a stale `blockHours` value from a prior billing type).
3. **`parseContractFormData` reads FormData conditionally by billing type** (only appending `blockHours`/`flatFeeAmount`/`hourlyRate` based on the submitted `billingType` value) rather than reading all 3 fields unconditionally and letting zod discard the extras. This mirrors what `ContractForm`'s client-side submit logic does (only the active field is ever appended to `FormData`) and avoids a class of bug where a hidden/stale form field's leftover value could reach the server at all.
4. **Zod issue messages are joined with `"; "`** (`parsed.error.issues.map((issue) => issue.message).join("; ")`) rather than returning only the first issue's message (as `companies.ts`/`sites.ts` do), per this plan's explicit required-interface spec: "return `{ error: string }` (concatenate zod issue messages) on failure." This is a deliberate deviation from the Wave 2 precedent, following this plan's own more specific instruction instead.
5. **P2025 detection uses `Prisma.PrismaClientKnownRequestError` instanceof check + `.code === "P2025"`**, importing `Prisma` from `@prisma/client`, rather than a loose duck-typed check on `err.code`. This is the standard, type-safe way to distinguish Prisma's "record not found" error from other thrown errors (including Next.js's internal redirect signal, which `createCompany`'s pattern in `companies.ts` has to specially avoid catching -- `updateContract`/`deleteContract` don't call `redirect()` so this concern doesn't apply here, but the explicit `instanceof` check keeps the catch block narrow regardless).
6. **Amount formatting in the tab list (`formatAmount`) does no currency/number library formatting** beyond a literal `$` prefix -- `flatFeeAmount`/`hourlyRate` come back from Prisma as its `Decimal` type, and calling `String()`/template-interpolating them directly relies on `Decimal`'s own `toString()`. This was verified compile-clean by `tsc --noEmit`; no runtime currency-formatting library was introduced since none is installed and adding one is out of this plan's scope.
7. **Deviation from literal Task 3 verification grep documented above** (`export function ContractsTab` vs. actual `export async function ContractsTab`) -- treated as a plan-script gap since 02-CONTEXT.md explicitly permits and expects this exact evolution, and the type-checked contract (`tsc --noEmit` exit 0) is the authoritative check per the plan's own stated verification-criteria priority.

## Issues Encountered
- The literal Task 3 verification command `grep -q 'export function ContractsTab' src/components/crm/contracts-tab.tsx` fails against the actual (and required, and context-endorsed) `export async function ContractsTab` signature. Documented in detail above under "Deviation note." All other verification commands, including the compiler-enforced `npx tsc --noEmit` and `npm run build`, pass. No other issues encountered -- Prisma schema, permissions, session helpers, and the placeholder stub all matched 02-01/02-02's documented shapes exactly; zod v4.5.4 (confirmed in `package.json`) supports `z.discriminatedUnion` with no compatibility issues.

## Escalations
None. No stop-gate condition was hit.

## Handoff Context

**For Phase 3 (ticketing SLA timers) and Phase 4 (billing engine), which depend on this plan's correctness:**
- `Contract.billingType` is the discriminator; exactly one of `blockHours` / `flatFeeAmount` / `hourlyRate` is non-null per contract row, enforced both by the zod discriminated union at input time (runtime-verified above, 15/15 cases) and by `toContractData` explicitly nulling the other two columns on every write (including updates that change billing type).
- `slaResponseMinutes` and `slaResolutionMinutes` are both nullable/optional -- a contract with neither set is valid and expected; Phase 3's SLA timer logic must handle the null case (no SLA target configured) rather than assuming both are always present.
- `endDate < startDate` is NOT validated anywhere in this plan (client form, zod schema, or Server Action) -- this is a known, accepted gap per the plan's explicit edge-case scope. If Phase 3/4 logic assumes `endDate >= startDate`, that invariant is not currently guaranteed by the data layer and should be validated at the point of consumption or added as a follow-up to `contractSchema`.
- No delete-confirmation UI or edit-form UI is wired up for contracts (matching the same gap 02-02 documented for `deleteSite`) -- `updateContract`/`deleteContract` exist, are RBAC-gated, and are covered by the P2025-not-found handling, but nothing in `ContractsTab`/`ContractForm` currently calls them. Only `createContract` is wired to the UI. Flagged here for a later plan to close if contract editing/deletion needs to be exposed.
- Decimal fields (`flatFeeAmount`, `hourlyRate`) are Prisma `Decimal` at the database/ORM layer; `contractSchema` coerces form input to plain JS `number` via `z.coerce.number()`. Phase 4's billing engine should be aware numbers passed through this path lose `Decimal`'s arbitrary-precision guarantees at the validation boundary (standard `z.coerce.number()` behavior, consistent with how `companySchema`/`siteSchema` handle their own fields) -- acceptable for a <25-user team's contract amounts per 02-CONTEXT.md's stated scale, not re-litigated here.

## Requirements Covered
- Contracts / service agreements per client (billing terms + SLA targets) -- `ContractsTab` lists existing contracts per company (billing type, relevant amount/rate, SLA response/resolution targets, start/end dates); `ContractForm` creates new contracts with billing-type-specific field validation; `createContract`/`updateContract`/`deleteContract` Server Actions are RBAC-gated via `CRM_MANAGE_ROLES` and handle not-found cases gracefully.
