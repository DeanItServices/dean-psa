# Plan 04-06 Summary: QuickBooks Invoice Push

## Result
**Status**: Complete
**Wave**: 4
**Agent**: engineering-backend-architect + testing-qa-verification-specialist
**Completed**: 2026-09-01T02:49:19Z

## Completed Tasks
1. Appended `pushInvoiceToQbo` to `src/lib/actions/invoices.ts` (plus one new import of `getValidQboClient`). Implements, in strict order: `requireRole(INVOICE_MANAGE_ROLES)` -> load invoice with `lineItems`+`company` -> pre-checks (not-found, status !== "finalized", `qboInvoiceId` already set, `company.qboCustomerId` null, `getValidQboClient()` null) -> atomic claim via conditional `updateMany` (sentinel `"PENDING"`) -> build best-effort QBO `Line`/`CustomerRef` payload -> `fetch` POST to `{base}/v3/company/{realmId}/invoice` -> success/401/non-ok/network-throw handling, each releasing the claim except the documented partial-failure path (QBO succeeded, local update failed) which intentionally leaves the claim in place.
2. Created `src/components/invoices/push-to-qbo-button.tsx` -- `"use client"`, `useTransition`-based pending state matching `ticket-form.tsx`'s pattern, inline error display.
3. Wired `<PushToQboButton>` into `src/app/(dashboard)/invoices/[invoiceId]/page.tsx` at the exact comment-marked location, gated `can(user.role, "invoice:push_qbo") && invoice.status === "finalized"`, with a `status === "pushed"` confirmation line (`qboInvoiceId`/`qboPushedAt`) as the alternative render. Updated the now-stale header comment that said QBO UI was intentionally omitted.

No stop-gate conditions were triggered: `getValidQboClient()`'s signature (`Promise<{accessToken, realmId} | null>`), `Invoice`/`InvoiceLineItem`/`Company.qboCustomerId` field names, and the invoice detail page's marked insertion point all matched the plan's expectations exactly on inspection of the actual files.

## Files Modified
- `src/lib/actions/invoices.ts` -- appended `pushInvoiceToQbo` (+ `getValidQboClient` import); `generateInvoice`/`finalizeInvoice` unchanged (verified via diff, see below)
- `src/components/invoices/push-to-qbo-button.tsx` (new) -- client component, `useTransition` pending state, inline error
- `src/app/(dashboard)/invoices/[invoiceId]/page.tsx` -- added `PushToQboButton` import, rendered it + pushed-status confirmation at the marked location, updated one stale doc comment

## Verification Results
```
$ npx tsc --noEmit
src/app/layout.tsx(20,50): error TS2304: Cannot find name 'LayoutProps'.
```
Only the documented pre-existing environment-gap error; no errors from any file this plan touched.

`git diff src/lib/actions/invoices.ts` confirms the only changes are: one new import line, and a pure append after the closing brace of `finalizeInvoice` (211 insertions, 0 deletions in that file) -- `generateInvoice`/`finalizeInvoice` bodies are byte-for-byte unchanged.

`git diff --stat` shows exactly 3 changed paths: `.planning/STATE.md` (pre-existing orchestrator-level modification from before this agent started, not touched by this plan), `src/app/(dashboard)/invoices/[invoiceId]/page.tsx`, `src/lib/actions/invoices.ts`, plus the new `src/components/invoices/push-to-qbo-button.tsx` file. No forbidden files were touched.

## Verification Commands
| Command | Exit Code | Result |
|---------|-----------|--------|
| `grep -q 'export async function pushInvoiceToQbo' src/lib/actions/invoices.ts` | 0 | PASS |
| `grep -q 'requireRole(INVOICE_MANAGE_ROLES)' src/lib/actions/invoices.ts` | 0 | PASS |
| `grep -q 'getValidQboClient' src/lib/actions/invoices.ts` | 0 | PASS |
| `grep -q 'qboCustomerId' src/lib/actions/invoices.ts` | 0 | PASS |
| `grep -q 'PENDING' src/lib/actions/invoices.ts` | 0 | PASS |
| `grep -q 'export async function generateInvoice' src/lib/actions/invoices.ts` | 0 | PASS |
| `grep -q 'export async function finalizeInvoice' src/lib/actions/invoices.ts` | 0 | PASS |
| `test -f src/components/invoices/push-to-qbo-button.tsx` | 0 | PASS |
| `grep -q '"use client"' src/components/invoices/push-to-qbo-button.tsx` | 0 | PASS |
| `grep -q 'PushToQboButton' 'src/app/(dashboard)/invoices/[invoiceId]/page.tsx'` | 0 | PASS |
| `npx tsc --noEmit` | 2 (pre-existing layout.tsx error only) | PASS (documented exception) |

## QA Self-Check Evidence
1. **Pre-checks before claim, claim before network call**: Traced `pushInvoiceToQbo` top to bottom. Order is: `requireRole` -> `db.invoice.findUnique` -> not-found check -> `status !== "finalized"` check -> `qboInvoiceId` truthy check -> `company.qboCustomerId` falsy check -> `getValidQboClient()` null check -> **only then** the `db.invoice.updateMany` atomic claim -> `claim.count !== 1` check -> **only then** payload construction and `fetch(...)`. No network call (`fetch`) appears anywhere before the claim; no claim appears anywhere before all four pre-checks. This is a straight-line function body with no early network access hidden in a helper.
2. **Claim where-clause + count check**: `db.invoice.updateMany({ where: { id: invoiceId, status: "finalized", qboInvoiceId: null }, data: { qboInvoiceId: "PENDING" } })` -- `where` includes both `status: "finalized"` and `qboInvoiceId: null` exactly as specified. The result is checked as `if (claim.count !== 1)` (strict inequality against the literal `1`, not a truthy/falsy check on `count`), so both `0` (lost the race or invoice no longer matches) and any hypothetical `>1` are treated as claim failure.
3. **Every post-claim failure path releases or is the documented exception**: after the claim succeeds, there are exactly 5 exit paths before the final success return: (a) `fetch` throws (catch block) -> releases via `update({ qboInvoiceId: null })`, returns error; (b) `qboResponse.status === 401` -> releases, returns auth error; (c) `!qboResponse.ok` (non-401 rejection) -> releases, returns QBO-rejection error; (d) 2xx response but missing `Invoice.Id` in the body -> returns error **without** releasing -- this is a narrow gap I identified: a malformed-but-2xx QBO response leaves `qboInvoiceId: "PENDING"` stuck. Given QBO's real API always returns the created `Invoice.Id` on a 2xx create response, this path is effectively unreachable in practice, but it is not the documented partial-failure exception (that exception is specifically "QBO succeeded AND local update failed", i.e. path (e) below). I flag this as a known residual risk rather than silently treating it as covered -- see Issues Encountered. (e) local `db.invoice.update` (setting `status: "pushed"`) throws -> returns the distinct partial-failure error message, deliberately does NOT release the claim (QBO already has a real invoice; releasing would let a retry create a duplicate). No other path returns without either releasing or being path (e).
4. **QBO failure doesn't change status away from finalized**: none of paths (a)/(b)/(c)/(d) touch the `status` field at all -- they only reset `qboInvoiceId` to `null` (or, in case (d), touch nothing). `status` remains `"finalized"` in the DB through every failure path except the terminal success path, which is the only place `status: "pushed"` is written.
5. **Button gating**: page renders `{can(user.role, "invoice:push_qbo") && invoice.status === "finalized" && <PushToQboButton .../>}`, matching the spec's exact condition (`status === "finalized" && can(user.role, "invoice:push_qbo")`) modulo operand order, which is semantically identical for `&&`.
6. **generateInvoice/finalizeInvoice unchanged**: `git diff src/lib/actions/invoices.ts` shows zero `-` (deletion) lines anywhere in the file and the only `+` lines are the one new import and the pure append after `finalizeInvoice`'s closing brace -- confirmed byte-for-byte unchanged.

## Key Decisions
- **QBO `ItemRef` placeholder**: the codebase has no Item-mapping concept between `InvoiceLineItem` and a QBO Item entity, so `SalesItemLineDetail.ItemRef.value` is hardcoded to `"1"` (commonly the default "Services" item id in a fresh QBO sandbox company), with the real line description carried in both `Line.Description` and `ItemRef.name`. This is an explicitly best-effort, unverified-against-live-Intuit-docs shape per the plan's own instruction; flagged as a follow-up risk, not fixed here (would require a real Item-mapping feature, out of scope).
- **Case (d) above (2xx response missing `Invoice.Id`)**: treated as a QBO rejection and the claim is left as `"PENDING"` rather than released, since the plan's spec only documents two release/no-release buckets ("QBO API error response" -> release; "local update failed after QBO succeeded" -> don't release) and doesn't explicitly cover "QBO returned 2xx but an unparseable/incomplete body". I chose not to release in this ambiguous case, erring toward the safer default (never auto-retry when it's unclear whether QBO actually created an invoice) rather than guessing. This is called out explicitly in Issues Encountered below rather than hidden.
- **401 checked before generic `!ok`**: implemented as two sequential `if` statements (401 first, then a general `!qboResponse.ok`) rather than a switch, so a 401 is never mis-reported as a generic "QuickBooks rejected the invoice" error.
- **QBO_ENVIRONMENT base URL**: `getQboApiBaseUrl()` reads `process.env.QBO_ENVIRONMENT`, returning the production host only when it is exactly `"production"`, defaulting to the sandbox host otherwise (matching `.env.example`'s `QBO_ENVIRONMENT=sandbox` default and 04-04's established env var).

## Issues Encountered
One residual edge case was identified during the execution agent's QA self-check: if QBO responds 2xx but the response body is missing/unparseable/lacks `Invoice.Id`, the originally-written code returned an error without releasing the `"PENDING"` claim, which would leave the invoice permanently stuck (the atomic claim's own `where: qboInvoiceId: null` clause would never match it again, so no future push attempt -- successful or not -- could ever re-claim it). This is a genuinely ambiguous case not covered by either of the plan's two explicitly documented failure buckets (QBO API error response -> release; local update succeeded-QBO-failed-locally -> don't release).

**Fixed during orchestrator review** (before commit): this case now DOES release the claim (reset `qboInvoiceId` to `null`), matching the treatment of the other pre-success failure paths (401, non-ok, network throw) so the invoice remains retryable rather than permanently locked. The returned error message was strengthened to explicitly warn the admin to verify in QuickBooks before retrying, since it remains genuinely unclear whether QBO created an invoice in this narrow case -- this preserves the original safety intent (don't silently assume no duplicate risk) while avoiding an unrecoverable stuck state. Verified via `npx tsc --noEmit` (only the documented pre-existing `layout.tsx` error) and a re-check that `generateInvoice`/`finalizeInvoice` remain byte-for-byte unchanged (zero deletion lines in `git diff`).

No other issues; no forbidden files touched; no scope expansion beyond the plan's write targets.

## Requirements Covered
- Invoices can be pushed to QuickBooks or Xero via API integration
