# Plan 04-05 Summary: Invoice Generation

## Result
**Status**: Complete
**Wave**: 3
**Agent**: engineering-backend-architect + engineering-frontend-developer
**Completed**: 2026-09-01T02:40:51Z

## Completed Tasks
- Task 1: Created `src/lib/validations/invoice.ts` (`generateInvoiceSchema`) and `src/lib/actions/invoices.ts` with `generateInvoice`/`finalizeInvoice` Server Actions, implementing the cumulative-lifetime block-hour rule, Decimal-to-number conversion, block-hour misconfiguration guard, flat-fee zero-entries exception, and the transaction-scoped double-billing guard.
- Task 2: Created the 3 invoice components (`generate-invoice-form.tsx`, `invoice-line-table.tsx`, `invoice-status-badge.tsx`) and the invoice list/detail pages, correctly role-gated and free of any QuickBooks UI.
- Task 3: Added exactly one new `<li>` to `app-sidebar.tsx` for Invoices, gated `invoice:view`, inserted after Tickets and before the Admin block.

## Files Modified
- `src/lib/validations/invoice.ts` (new) — `generateInvoiceSchema` with periodEnd >= periodStart refinement
- `src/lib/actions/invoices.ts` (new) — `generateInvoice`, `finalizeInvoice`, and a locally re-derived `resolveActiveContract` (identical rule to `tickets.ts`, since that function is not exported)
- `src/components/invoices/generate-invoice-form.tsx` (new) — company select + 2 date inputs, follows `ticket-form.tsx` pending/error pattern
- `src/components/invoices/invoice-line-table.tsx` (new) — line item table with description/quantity/unitRate/amount, colSpan=4 empty state
- `src/components/invoices/invoice-status-badge.tsx` (new) — draft/finalized/pushed badge, follows `sla-badge.tsx` shape
- `src/app/(dashboard)/invoices/page.tsx` (new) — invoice list, gated `invoice:view`/`invoice:manage`
- `src/app/(dashboard)/invoices/[invoiceId]/page.tsx` (new) — invoice detail, gated `invoice:view`; inline server-action `<form>` for Finalize (gated `invoice:manage`, draft-only), no QuickBooks UI (comment marks Plan 04-06's future insertion point)
- `src/components/nav/app-sidebar.tsx` (modified) — added one `<li>` for Invoices, gated `invoice:view`

## Verification Results
```
$ npx tsc --noEmit
src/app/layout.tsx(20,50): error TS2304: Cannot find name 'LayoutProps'.
```
This is the documented pre-existing environment-gap error (missing generated `.next/types`), unrelated to this plan's files. No other tsc errors were produced by any file this plan touched or created.

All grep/test verification checks passed (see table below).

`git diff --stat` confirms only `src/components/nav/app-sidebar.tsx` was modified among tracked files (10 insertions, matching the single new `<li>` block) plus the 4 new file/directory paths this plan was scoped to create. `.planning/STATE.md` shows a pre-existing modification from before this task started (orchestrator-level phase tracking), not touched by this agent.

## Verification Commands
| Command | Exit Code | Result |
|---------|-----------|--------|
| `test -f src/lib/validations/invoice.ts` | 0 | PASS |
| `test -f src/lib/actions/invoices.ts` | 0 | PASS |
| `grep -q 'export async function generateInvoice' src/lib/actions/invoices.ts` | 0 | PASS |
| `grep -q 'export async function finalizeInvoice' src/lib/actions/invoices.ts` | 0 | PASS |
| `grep -q 'requireRole(INVOICE_MANAGE_ROLES)' src/lib/actions/invoices.ts` | 0 | PASS |
| `grep -q 'computeContractCharges' src/lib/actions/invoices.ts` | 0 | PASS |
| `grep -q 'priorInvoicedBillableMinutes' src/lib/actions/invoices.ts` | 0 | PASS |
| `grep -q 'toNumber' src/lib/actions/invoices.ts` | 0 | PASS |
| `test -f src/components/invoices/generate-invoice-form.tsx` | 0 | PASS |
| `test -f src/components/invoices/invoice-line-table.tsx` | 0 | PASS |
| `test -f src/components/invoices/invoice-status-badge.tsx` | 0 | PASS |
| `test -f 'src/app/(dashboard)/invoices/page.tsx'` | 0 | PASS |
| `test -f 'src/app/(dashboard)/invoices/[invoiceId]/page.tsx'` | 0 | PASS |
| `grep -q 'invoice:view' src/components/nav/app-sidebar.tsx` | 0 | PASS |
| `grep -q '/invoices' src/components/nav/app-sidebar.tsx` | 0 | PASS |
| `npx tsc --noEmit` | 2 (pre-existing layout.tsx error only) | PASS (documented exception) |

## Key Decisions
- **Cumulative block-hour query**: `priorInvoicedBillableMinutes` is computed via `db.timeEntry.aggregate({ where: { contractId: contract.id, invoiceLineItemId: { not: null } }, _sum: { durationMinutes: true } })` — summing across ALL prior invoices for the contract regardless of date range, exactly as specified. The required assumption comment about Contract deletion policy (onDelete: SetNull silently dropping history) is included verbatim above this query.
- **Decimal conversion**: `contract.flatFeeAmount`/`contract.hourlyRate` are converted via `.toNumber()` (or left `null`) into a `ContractBillingInput` before ever reaching `computeContractCharges`; `blockHours` (a plain `Int`) is passed through unconverted.
- **Block-hour misconfiguration guard**: checked immediately after the Decimal conversion, before querying prior-invoiced minutes or calling `computeContractCharges`, returning the exact specified error string.
- **Zero-entries handling**: flat-fee contracts are exempted from the "no billable time entries" rejection (checked via `contract.billingType === "flat_fee"`); all other billing types with zero current-period entries AND a zero computed charge amount are rejected.
- **`resolveActiveContract` re-derivation**: since `tickets.ts`'s `resolveActiveContract` is a private (non-exported) function in a different file, and this plan's forbidden-targets list marks `tickets.ts` read-only, the identical query (companyId match, `endDate IS NULL OR endDate >= now()`, `orderBy [{startDate: "desc"}, {id: "desc"}]`, take first) was re-implemented verbatim in `invoices.ts` per the plan's explicit instruction.
- **Transaction-scoped double-billing guard**: used the callback form of `db.$transaction` as required. Inside the transaction: create Invoice, create InvoiceLineItem, re-query `tx.timeEntry.findMany` for still-unclaimed consumed entries and compare counts (throwing `CONCURRENT_INVOICE_CONFLICT` on mismatch to force a full rollback), then `tx.timeEntry.updateMany` to stamp `invoiceLineItemId`, with a second count check as defense-in-depth. The outer `try/catch` translates the thrown sentinel error into the specified structured `{ error: ... }` response.
- **Finalize button placement**: rather than adding a 4th component file (not listed in this plan's write targets), the invoice detail page renders the Finalize control as an inline React Server Component `<form>` with a server action closure calling `finalizeInvoice(invoice.id)` directly — keeping the file list exactly as scoped (3 components only) while still meeting the "Finalize button calling finalizeInvoice" requirement.
- **`InvoiceLineItem.quantity`/`unitRate`/`amount` typing**: `invoice-line-table.tsx` accepts either a Prisma `Decimal` or plain `number` for currency/quantity formatting (via `Prisma.Decimal` type import and a runtime `typeof` check), since Server Components pass the raw Prisma-fetched rows (Decimal-typed) directly without pre-conversion.

## Issues Encountered
None. No stop-gate conditions were triggered: `computeContractCharges`'s signature matched the plan's documentation exactly, `TimeEntry`'s actual fields matched the plan's query assumptions, and `resolveActiveContract`'s rule was unchanged from `tickets.ts`'s current implementation.

## Requirements Covered
- Invoice generation from logged time and contract terms
- Billing rules correctly compute charges for block-hour, flat-fee managed services, and hourly break-fix contract types
