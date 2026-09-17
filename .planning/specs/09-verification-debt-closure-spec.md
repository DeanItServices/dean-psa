# Phase 9: Verification & Debt Closure — Specification

**Status**: Approved for planning — critique PASS (acceptance checks negative-controlled)
**Date**: 2026-09-17
**Source**: `.planning/ROADMAP.md` Phase 9; `.planning/explorations/2026-09-02-launch-readiness-design.md`
**Supersedes in scope**: criterion 5 (QBO `ItemRef`) is **deferred to Phase 10** by user decision, 2026-09-17.

## 1. Scope

Four deliverables. The fifth ROADMAP criterion (QBO connection-level default item) leaves this
phase because it requires verification against a real or sandbox QuickBooks company, and no
`QBO_*` credentials exist in this environment. Shipping it unverified would repeat Phase 8's
ACME situation — code that is correct by construction and unobserved. It becomes Phase 10.

| # | Deliverable |
|---|---|
| D1 | `npm run test:e2e` executes against a real browser on a clean install and passes; any failure attributable to `fullyParallel: true` on a shared database is recorded as evidence |
| D2 | `deleteTicket` is admin-only, and refuses when any of the ticket's time entries is invoiced, with an error that identifies the invoice |
| D3 | A confirmation dialog on the ticket detail page invokes `deleteTicket`; the two `test.fixme` cases become three real cases |
| D4 | `deleteTicket`'s docstring names the `TimeEntry` cascade |

## 2. Verified current state

Every line below was checked against the tree at `9682c04` on 2026-09-17.

| Fact | Evidence |
|---|---|
| `deleteTicket` gates on `TICKET_MANAGE_ROLES` = `["technician","dispatcher","admin"]` | `src/lib/permissions.ts:99`, `src/lib/actions/tickets.ts` `deleteTicket` |
| It carries a technician-ownership branch (may delete only own ticket) | `deleteTicket`, `user.role === "technician"` branch |
| It has **no** invoiced-time check | same function, body is gate → ownership → `db.ticket.delete` |
| It `redirect("/tickets")` on success | last statement of `deleteTicket` |
| Zero call sites in `src/` | project-wide grep for `deleteTicket` outside its definition |
| Two `test.fixme` cases | `e2e/tickets.spec.ts:229` and `:244` |
| Docstring names only `TicketComment` cascade | `deleteTicket` docstring |
| `TimeEntry.ticket` is `onDelete: Cascade` | `prisma/schema.prisma:274` |
| `TimeEntry.invoiceLineItem` is `onDelete: SetNull` | `prisma/schema.prisma:284` |
| `Invoice` has **no** human-facing number field | `model Invoice` — `id` (cuid), `companyId`, `periodStart/End`, `status`, `subtotal`, `total`, `qboInvoiceId` |
| `requireRole()` **redirects**, it does not return an error | `src/lib/session.ts:249-261` — `redirect("/unauthorized")` |
| Established destructive-action UI pattern | `src/components/admin/user-row-actions.tsx` — `AlertDialog` + `useTransition` + inline `{ error }` |
| `fullyParallel: true` globally; `last-active-admin` overrides to `false` with `dependencies: ["lifecycle"]` | `playwright.config.ts:62,83-85` |
| `reuseExistingServer: false` unconditionally | `playwright.config.ts:93` |

**ROADMAP citation drift, recorded rather than silently fixed.** ROADMAP and the exploration
doc both cite `prisma/schema.prisma:265` for `TimeEntry.ticket`; it is at `:274` (`:265` is the
`model TimeEntry` header). The exploration doc cites `:280` for `invoiceLineItem`; it is at
`:284`. The underlying facts hold. This is the third instance of the stale-`file:line` class
that Phase 8's retrospective recorded as action item 5 — cite symbols, not line numbers.

## 3. Decisions this spec makes

### 3.1 Admin-only supersedes ownership-scoped delete

`deleteTicket`'s current technician-ownership branch is removed, not extended. This is a
deliberate narrowing recorded in the exploration doc: *"Ticket deletion touches billing
history; restricting it to admins matches who is accountable for that data. Technicians close
tickets, they don't delete them."* It supersedes 06-CONTEXT.md's "Ownership-scoped delete
approach", which the docstring still describes. **The docstring must be rewritten, not
appended to** — leaving the old rationale in place would describe a model the code no longer
implements, which is the defect class Phase 8 spent four review cycles on.

### 3.2 An unauthorized delete REDIRECTS; it does not return an error

`requireRole(ADMIN_MANAGE_ROLES)` calls `redirect("/unauthorized")`. Consequences that the
implementation and the tests must both respect:

- The dialog cannot display "you are not allowed" — control never returns to it.
- A non-admin E2E case must assert the **redirect**, or assert at the Server Action boundary,
  never merely that a button is hidden. Phase 7's review found a test that proved the layout
  gate rather than the security boundary; that test would have passed with the role check
  deleted. Hiding the button is defence in depth, not the assertion.
- Because non-admins are redirected, the delete affordance SHOULD also be hidden for them —
  but the test's discriminator is the server behaviour.

### 3.3 `redirect()` on success is not an error

`deleteTicket` ends in `redirect("/tickets")`, and Next.js implements `redirect()` by throwing
a control-flow signal. The client component must not catch that and render it as a failure.
`src/components/admin/user-row-actions.tsx` is the pattern to copy for `{ error }` handling,
but it calls actions that **return** rather than redirect, so its `catch` shape cannot be
copied verbatim. Re-derive it; do not assume.

### 3.4 What "naming the invoice" means

`Invoice` has no invoice number. The refusal message identifies the invoice by the fields that
exist and are meaningful to an admin:

> `Cannot delete: time on this ticket is billed to {company.name}'s invoice for {periodStart}–{periodEnd} ({status}). Void or adjust that invoice first.`

The cuid is not shown in the message; it is not meaningful to a human and the company+period
pair is unique enough to act on. Implementations MAY include it in a returned field for
support purposes, but the human-facing string is as above.

### 3.5 The refusal precedes the delete

The invoiced-time query runs **before** `db.ticket.delete`, for the same reason the ownership
lookup did: a refused admin gets a clear billing error rather than a generic not-found. A
concurrently-deleted ticket still falls through to the existing P2025 path.

### 3.6 First E2E run stays on the dev database

Per the exploration doc: *"Buying the test-DB setup before any evidence risks solving a problem
the run may not have."* `fullyParallel: true` on a shared database is a real hazard; if it
bites, the failure signature will say so and the separate-test-database decision gets made on
evidence. D1 records that evidence either way — including a positive statement when no
parallelism failure occurs.

### 3.7 The browser install must be real

During Phase 8's session the suite was run 45/45 green, but only after hand-bridging a browser
layout mismatch: the project pins `@playwright/test ^1.62.1`, which expects
`chromium_headless_shell-1234`, while the image ships `-1194` with a different internal layout.
**That bridge is not evidence for D1.** D1 requires either a clean `npx playwright install
chromium` or an explicit, recorded statement of the environment-specific step required, so that
"passes against a real browser" is not quietly resting on a symlink.

## 4. Acceptance checks

Each check must **fail on the pre-change tree and pass after** — Phase 8 retrospective action
item 1. A check that cannot produce its own failing state is not a check. The negative-control
result is to be recorded in the plan summary.

| # | Check | Fails before because |
|---|---|---|
| A1 | `grep -q 'ADMIN_MANAGE_ROLES' src/lib/actions/tickets.ts` | file currently references only `TICKET_MANAGE_ROLES` |
| A2 | `! grep -q 'You can only delete tickets assigned to you' src/lib/actions/tickets.ts` | that string is present today |
| A3 | `grep -q 'invoiceLineItemId' src/lib/actions/tickets.ts` | no invoiced-time check exists |
| A4 | `grep -qF 'TimeEntry' <deleteTicket docstring range>` | docstring names only `TicketComment` |
| A5 | `! grep -q 'test.fixme' e2e/tickets.spec.ts` | two `test.fixme` calls present |
| A6 | `grep -rq 'deleteTicket' src/components/` | zero call sites outside the action today |
| A7 | `npm run test:e2e` exits 0 with the new cases included | new cases do not exist |

**Negative controls, executed 2026-09-17 against `9682c04`.** A1, A2, A3, A5 and A6 were each
run on the unmodified tree and each failed, so each carries real signal. A4's scoping concern
is resolved by measurement rather than caution: `grep -c TimeEntry src/lib/actions/tickets.ts`
returns **0**, so a whole-file grep is unambiguous and no docstring-range scoping is needed.
A7 is the suite itself and cannot be negative-controlled without writing the cases first.

## 5. Out of scope

- QBO `ItemRef` / default item mapping — **Phase 10**.
- Any schema migration. D2 is a query-level guard; `onDelete` stays as declared. The
  exploration doc considered and rejected `onDelete: Restrict` ("no risk of a migration failing
  against existing rows").
- Introducing a separate test database. That decision waits on D1's evidence.
- Archiving or soft-delete for tickets. The exploration doc's suggestion that an admin "closes
  or archives it instead" refers to the existing status workflow, not a new feature.

## 6. Risks

| Risk | Mitigation |
|---|---|
| The redirect-vs-error distinction (3.2, 3.3) is subtle and easy to get backwards in both the component and the tests | Called out as its own decision; plans must verify the success path and the refusal path separately |
| An E2E case that asserts a hidden button rather than server behaviour | 3.2 states the discriminator explicitly; Phase 7 precedent cited |
| ~~A4's grep matching `TimeEntry` elsewhere in the file~~ | Resolved: measured at 0 occurrences today |
| The first real E2E run surfaces unrelated pre-existing failures, expanding scope | D1 fixes what breaks, but records anything out of scope rather than absorbing it |
