# Phase 9: Verification & Debt Closure — Context

**Goal**: Run the E2E suite against a real browser for the first time, and close the ticket-delete
debt carried out of Phase 6 — making deletion admin-only and refusing it when the ticket's time
is already invoiced.

**Milestone**: Launch Readiness (v1 Go-Live) — Phases 7-9.
**Planned**: 2026-09-17, from `9682c04` (Phase 8 merged, PR #23).
**Spec**: `.planning/specs/09-verification-debt-closure-spec.md` — read it first; it carries the
verified current state, the decisions below in full, and the negative-controlled acceptance checks.

## Scope change: QBO deferred to Phase 10

ROADMAP's fifth criterion (replace the hardcoded QBO `ItemRef.value: "1"` with a connection-level
default chosen from a live item list) **is not in this phase.** User decision, 2026-09-17.

The criterion requires the item-list endpoint be "verified against the real company or a sandbox
first". There is no `.env`, no `QBO_*` variable in the environment, and no credential anywhere in
the tree. Building it here would mean shipping an unobserved integration — the same position
Phase 8 ended in with ACME issuance, which its review had to label NOT VERIFIED. Deferring keeps
the verification requirement honest instead of quietly dropping it. The `ItemRef` hardcode
remains documented debt, unchanged from Phase 6.

## Architecture proposals: skipped by user

Every architectural choice this phase needs was already recorded, with rationale and rejected
alternatives, in `.planning/explorations/2026-09-02-launch-readiness-design.md`:

| Decision | Chosen | Rejected |
|---|---|---|
| `deleteTicket` resolution | **Admin-only** | wire owner-scoped button; remove the dead action |
| TimeEntry cascade on delete | **Refuse when any time entry is invoiced** | refuse if any time logged; `onDelete: Restrict` migration; counting warning dialog |
| E2E database | **First real run on the dev DB, decide after** | promote a separate test DB now |

Proposals would have re-litigated settled decisions.

## Decisions carried into the plans

### Admin-only supersedes Phase 6's ownership-scoped delete
The technician-ownership branch is **removed**, not extended. The exploration doc's rationale:
"Ticket deletion touches billing history; restricting it to admins matches who is accountable for
that data. Technicians close tickets, they don't delete them." This supersedes 06-CONTEXT.md's
"Ownership-scoped delete approach", which `deleteTicket`'s docstring still describes — so the
docstring is **rewritten, not appended to**. Leaving the old rationale would describe a model the
code no longer implements.

### An unauthorized delete redirects; it does not return an error
`requireRole()` calls `redirect("/unauthorized")` (`src/lib/session.ts:249-261`). The dialog
cannot display a "not allowed" message because control never returns to it, and the non-admin
E2E case must assert the redirect or the Server Action boundary — **never merely that a button is
hidden**. Phase 7's review found a test that proved the layout gate rather than the security
boundary; it would have passed with the role check deleted.

### `redirect()` on success is not a failure
`deleteTicket` ends in `redirect("/tickets")`, which Next.js implements by throwing a control-flow
signal. `src/components/admin/user-row-actions.tsx` is the destructive-action pattern to follow,
but the actions it calls **return** rather than redirect, so its `catch` shape cannot be copied
verbatim. Re-derive it.

### "Naming the invoice" means company and period
`model Invoice` has no invoice-number field — only a cuid `id`, `companyId`, `periodStart/End`,
`status`, `subtotal`, `total`, `qboInvoiceId`. The refusal identifies the invoice by the fields
that exist and mean something to an admin: company name, period, status.

## Existing assets

| Asset | Relevance |
|---|---|
| `src/lib/actions/tickets.ts` → `deleteTicket` | The function being hardened. Currently `TICKET_MANAGE_ROLES` + ownership branch, no invoiced-time check |
| `src/components/admin/user-row-actions.tsx` | The established `AlertDialog` + `useTransition` + inline-`{error}` pattern |
| `src/components/ui/alert-dialog.tsx` | Already present; no new dependency needed |
| `e2e/tickets.spec.ts:229,244` | The two `test.fixme` cases to replace |
| `playwright.config.ts` | `fullyParallel: true` globally; `last-active-admin` overrides to `false` with `dependencies: ["lifecycle"]`; `reuseExistingServer: false` unconditionally |

## Retrospective constraints (from `.planning/memory/RETRO.md`, Phase 8)

These are HIGH-priority action items applied as plan constraints:

1. **Every verification command must be shown to fail on the pre-change tree.** Five of this
   phase's six acceptance checks were negative-controlled during spec critique and all failed
   correctly; the sixth was closed by measurement. Plans must record the negative-control result
   for any check they add.
2. **Check an agent's tool grants before writing its brief.** Phase 8 sent a "verify by
   execution" brief to a read-only agent type.
3. **Drive stale-text sweeps from one `grep` over the whole tree**, and paste the command into
   the summary. Phase 8 fixed the same stale instruction in three separate cycles because sweeps
   ran from memory.
5. **Cite symbols, never `file:line`, across files.** ROADMAP and the exploration doc both cite
   `prisma/schema.prisma:265` for `TimeEntry.ticket`; it is at `:274`. The exploration doc cites
   `:280` for `invoiceLineItem`; it is at `:284`. Third instance of this class.

## Plan structure

| Plan | Wave | Depends on | Agents |
|---|---|---|---|
| 09-01 E2E first real run | 1 | — | testing-qa-verification-specialist |
| 09-02 `deleteTicket` hardening | 1 | — | engineering-backend-architect + engineering-security-engineer |
| 09-03 Delete UI, real tests, final gate | 2 | 09-01, 09-02 | engineering-frontend-developer + testing-qa-verification-specialist |

### File ownership — the one real conflict, pre-empted
09-01 and 09-02 run in parallel and touch disjoint trees (`e2e/**` vs `src/lib/actions/tickets.ts`).
The exception: **09-01 may fix anything under `e2e/` EXCEPT the `test.fixme` block in
`e2e/tickets.spec.ts`**, which 09-03 owns. If 09-01's run surfaces a failure inside that block, it
records the finding and leaves the file to 09-03.

## Known environment hazard

The suite was observed passing 45/45 during the Phase 8 session, but only after hand-bridging a
browser layout mismatch: the project pins `@playwright/test ^1.62.1`, which expects
`chromium_headless_shell-1234`, while this image ships `-1194` with a different internal directory
layout (`chrome-linux/headless_shell` vs `chrome-headless-shell-linux64/chrome-headless-shell`).
**That bridge is not evidence for this phase's first criterion.** 09-01 must either perform a
clean `npx playwright install chromium` or record the exact environment-specific step required.
