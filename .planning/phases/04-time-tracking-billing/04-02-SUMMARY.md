# Plan 04-02 Summary: Billing Computation & Timer Logic

## Result
**Status**: Complete
**Wave**: 1
**Agent**: engineering-backend-architect
**Completed**: 2026-09-01T02:16:39Z

## Completed Tasks

**Task 1 — Create src/lib/billing.ts**: Read `prisma/schema.prisma` in full and cross-checked against `04-01-SUMMARY.md` to confirm `Contract.billingType`/`blockHours Int?`/`flatFeeAmount Decimal? @db.Decimal(10,2)`/`hourlyRate Decimal? @db.Decimal(10,2)` match the plan's assumptions exactly, and that `TimeEntry.durationMinutes Int?`/`isBillable Boolean @default(true)` exist as expected. Read `src/lib/sla.ts` in full as the pattern reference (pure functions, exported types, no I/O, module-level doc comment explaining role and cross-plan sharing rationale). Created `src/lib/billing.ts` exporting `ContractBillingInput`, `BillingChargeResult`, `computeBlockHourCharge`, `computeFlatFeeCharge`, `computeHourlyBreakfixCharge`, and `computeContractCharges` with the exact specified signatures. Implemented the cumulative-lifetime block-hour rule: `computeBlockHourCharge` sums `priorInvoicedBillableMinutes + currentPeriodBillableMinutes`, compares against `blockHours * 60`, and bills only the current-period-bounded overage (`min(currentPeriodBillableMinutes, max(0, cumulativeTotalMinutes - blockMinutes))`) at `hourlyRate` — never a per-period-reset variant. Null `blockHours`/`hourlyRate` returns a zero-amount result rather than throwing. `computeFlatFeeCharge` takes no minutes argument. `computeHourlyBreakfixCharge` bills all current-period minutes at `hourlyRate`, defaulting to 0 if null. `computeContractCharges` dispatches on `billingType` to the three functions, passing only the arguments each needs.

**Task 2 — Create src/lib/timer.ts**: Created `src/lib/timer.ts` exporting `computeElapsedMinutes(startedAt, endedAt, now?)` (returns whole minutes via `Math.floor`, uses `now ?? new Date()` when `endedAt` is null for a running timer, clamps to 0 on clock skew where the end time precedes `startedAt`) and `formatDuration(minutes)` (formats as `"Xh Ym"`, e.g. `125` → `"2h 5m"`, `0` → `"0h 0m"`, never throws on 0 or large values). Both functions use only `Date`/arithmetic — no browser-only or Node-only APIs — so they work identically client-side (live elapsed display) and server-side (`stopTimer` action's final `durationMinutes` computation).

## Files Modified
- `src/lib/billing.ts` — new file. Pure contract-billing charge computation module (cumulative-lifetime block-hour, flat-fee, hourly-breakfix, and the `computeContractCharges` dispatcher).
- `src/lib/timer.ts` — new file. Pure timer duration/elapsed-time helper module (`computeElapsedMinutes`, `formatDuration`).

## Verification Results

`test -f src/lib/billing.ts && test -f src/lib/timer.ts`: both files exist.

`grep` checks for all 6 exported functions: all found (`computeContractCharges`, `computeBlockHourCharge`, `computeFlatFeeCharge`, `computeHourlyBreakfixCharge`, `computeElapsedMinutes`, `formatDuration`).

`npx tsc --noEmit`:
```
src/app/layout.tsx(20,50): error TS2304: Cannot find name 'LayoutProps'.
```
Exit code 2, but this is the sole reported error and matches verbatim the pre-existing, documented `LayoutProps` error recorded in `04-01-SUMMARY.md` (caused by missing `.next/types` in this fresh worktree — a known Next.js 16 App Router environment gap, not a code defect). Zero errors originate from `src/lib/billing.ts` or `src/lib/timer.ts`.

`git status --porcelain`:
```
?? src/lib/billing.ts
?? src/lib/timer.ts
```
`git diff --stat` shows no modified tracked files. Only the two new files were added; no forbidden target was touched.

## Verification Commands
| Command | Exit Code | Result |
|---------|-----------|--------|
| `test -f src/lib/billing.ts` | 0 | Exists |
| `test -f src/lib/timer.ts` | 0 | Exists |
| `grep -q 'export function computeContractCharges' src/lib/billing.ts` | 0 | Found |
| `grep -q 'export function computeBlockHourCharge' src/lib/billing.ts` | 0 | Found |
| `grep -q 'export function computeFlatFeeCharge' src/lib/billing.ts` | 0 | Found |
| `grep -q 'export function computeHourlyBreakfixCharge' src/lib/billing.ts` | 0 | Found |
| `grep -q 'export function computeElapsedMinutes' src/lib/timer.ts` | 0 | Found |
| `grep -q 'export function formatDuration' src/lib/timer.ts` | 0 | Found |
| `npx tsc --noEmit` | 2 | Only pre-existing, unrelated `layout.tsx` `LayoutProps` error; zero errors from this plan's new files |
| `git status --porcelain` / `git diff --stat` | 0 | Only `src/lib/billing.ts` and `src/lib/timer.ts` added; no other file touched |

## Key Decisions

1. **Decimal-to-number conversion left entirely to the caller**: `ContractBillingInput` types `flatFeeAmount`/`hourlyRate` as `number | string | null` per the plan's spec (since Prisma `Decimal` is a Decimal.js-like object at runtime, not a plain number or string). Internally, `billing.ts` normalizes via a small private `toNumberOrNull` helper (`Number(value)`) so the module tolerates either a pre-converted `number` or a stringified decimal without throwing — but the module-level doc comment is explicit that Plan 04-05 remains responsible for the `.toNumber()` conversion at the Prisma-query boundary (per 04-CONTEXT.md's plan-critique fix #6), and for computing `priorInvoicedBillableMinutes` before calling in. This module performs no DB-shape-aware conversion beyond tolerating string/number interchangeably.
2. **Cumulative block-hour overage bounded to the current period**: Implemented exactly as specified — `overageMinutes = min(currentPeriodBillableMinutes, max(0, cumulativeTotalMinutes - blockMinutes))` — so a contract already over its lifetime block allotment from a prior invoice does not re-bill previously-invoiced overage minutes again on a later invoice; only the newly-added current-period minutes that push (or continue) the contract past its allotment are billed now.
3. **`computeContractCharges` dispatch via `switch`**: Since `ContractBillingInput.billingType` is a closed union of exactly 3 literals matching the 3 helper functions, a `switch` with no `default` case gives exhaustiveness checking for free and mirrors `sla.ts`'s straightforward control-flow style.

## Issues Encountered
None. `npx tsc --noEmit` reproduces only the documented pre-existing `src/app/layout.tsx` `LayoutProps` error (out of scope, forbidden target, and confirmed unrelated to this plan's changes per `04-01-SUMMARY.md`'s precedent).

## Requirements Covered
- Contract-based billing rules (block hours, flat-fee managed services, hourly break-fix, etc.)
- Timer-based time entry against tickets
