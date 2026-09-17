# 09-02 — `deleteTicket`: admin-only, refuse invoiced time, correct the docstring

**Status**: Complete
**Wave**: 1
**Agent**: engineering-backend-architect + engineering-security-engineer
**Date**: 2026-09-17
**Files modified**: `src/lib/actions/tickets.ts` (only)
**Diffstat**: 66 insertions, 23 deletions

## What changed

- Gate moved from `TICKET_MANAGE_ROLES` to `ADMIN_MANAGE_ROLES`; the technician-ownership branch
  deleted outright, not demoted to a redundant inner guard.
- An invoiced-time refusal added **before** `db.ticket.delete`, so a refused admin gets the
  billing error rather than a generic not-found, and a concurrently-deleted ticket still falls
  through to the existing P2025 path.
- Docstring rewritten, not appended to. It now describes admin-only deletion and why, both
  cascades (`TicketComment` and `TimeEntry`), the `SetNull` consequence that makes the TimeEntry
  cascade the dangerous one, and the fact that `requireRole` redirects rather than returning.

## The refusal string, with a worked example

```
Cannot delete: time on this ticket is billed to ${company}'s invoice for ${start} - ${end} (${status}). Void or adjust that invoice first.
```

Produced by running the format code, not written from imagination:

```
Cannot delete: time on this ticket is billed to Acme Manufacturing's invoice for Aug 1, 2026 - Aug 31, 2026 (finalized). Void or adjust that invoice first.
```

**09-03 must copy this template verbatim for its assertion.**

## Facts verified rather than assumed

- **`model Invoice` has no invoice-number field.** Full field list read from the schema: `id`,
  `companyId`, `contractId`, `periodStart`, `periodEnd`, `status`, `subtotal`, `total`,
  `qboInvoiceId`, `qboPushedAt`, `lineItems`, `createdAt`, `updatedAt`. The nearest candidate,
  `qboInvoiceId`, is a nullable QuickBooks foreign key — null for every un-pushed invoice — so it
  cannot serve as a human-facing identifier. Company + period + status is the only design the data
  supports.
- **`requireRole()` redirects rather than returning**, confirmed by reading `src/lib/session.ts`.
  The return value is discarded safely *only* because the failure mode is a throw.
- **`Ticket` has exactly two children**, so the docstring's "BOTH" is literally true:
  `comments TicketComment[]` and `timeEntries TimeEntry[]`, both `onDelete: Cascade`.
- **The guard restores an invariant this codebase already enforces.** `deleteTimeEntry`
  (`src/lib/actions/time-entries.ts`) already refuses on `invoiceLineItemId !== null`, reasoning
  that "an already-invoiced entry must never be deleted out from under its InvoiceLineItem."
  `deleteTicket` was a cascade-shaped bypass of that existing rule, not a new policy.

## Negative controls

The executing agent did not take the recorded controls on faith — it re-ran every check against the
unmodified tree at `e58c893` before editing, independently reproducing the spec's section-4 record.

| Check | Pre-change | Post-change |
|---|---|---|
| `grep -q 'ADMIN_MANAGE_ROLES'` | FAIL | PASS |
| `! grep -q 'You can only delete tickets assigned to you'` | FAIL | PASS |
| `grep -q 'invoiceLineItemId'` | FAIL | PASS |
| `grep -q 'TimeEntry'` | FAIL (0 occurrences) | PASS |
| `! grep -q 'assignedToId !== user.id'` | FAIL | PASS |
| `grep -q 'Cannot delete'` | FAIL | PASS |
| `! grep -q 'Ownership-scoped delete approach'` | FAIL | PASS |
| `npx tsc --noEmit` | **PASS (exit 0)** — not a negative control | PASS |
| `npm run lint` | **PASS (exit 0)** — not a negative control | PASS, one pre-existing warning unchanged |

### A defect in this plan's own frontmatter, found by the executing agent

The frontmatter claimed *"Every check below was negative-controlled on 2026-09-17 against 9682c04
and FAILED there."* That is **false for `npx tsc --noEmit` and `npm run lint`** — both exit 0 on a
clean pre-change tree by construction, as the agent measured and the coordinator independently
reproduced by stashing the change and re-running both.

This is the "verification command that cannot fail" pattern that Phase 8's retrospective named as
this project's most persistent defect class — committed in a plan written the day after that
retrospective. The frontmatter comments in **all three** Phase 9 plans have been corrected to
distinguish negative controls from regression guards.

## Scope check — non-vacuous

`git status --porcelain | awk '{print $2}' | grep -qvE '...'` printed `scope ok`, and the agent
deliberately ran it **after** editing, against a tree containing exactly one path
(` M src/lib/actions/tickets.ts`), so `grep -qv` had a real input to discriminate on. Run before
editing, on the clean tree, it would have printed `scope ok` from empty input — no signal.

## Stale-text sweep (retro action item 3)

```
grep -rn "Ownership-scoped delete approach\|only delete tickets assigned to you\|ownership-scoped" \
  --include=*.ts --include=*.tsx --include=*.md . \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git
```

Zero hits under `src/`. All remaining hits are `.planning/**` historical records, which correctly
describe what earlier phases did, plus one live documentation line handed to 09-03 (below).

## Decisions

1. **Refusal wording** follows the spec's possessive form (the plan's "billed to Acme Corp invoice"
   is ungrammatical) with an ASCII hyphen rather than the spec's en-dash — `src/lib/actions/`
   contains zero non-ASCII bytes, and a string that becomes a test assertion is safer in ASCII.
   Spaced ` - ` because medium dates contain commas.
2. **Explicit `Intl.DateTimeFormat("en-US", { dateStyle: "medium" })`** at module scope rather than
   `toLocaleDateString()`, which would render against the *server's* locale and make 09-03's
   assertion environment-dependent.
3. **Deterministic `orderBy: [{ startedAt: "asc" }, { id: "asc" }]`** on the `findFirst` — a bare
   `findFirst` has no defined order, so with several invoiced entries the message could name a
   different invoice run to run. Mirrors the existing tiebreak in `resolveActiveContract`.
4. **No existence pre-check.** Under admin-only there is no reason to look the ticket up first; a
   missing ticket falls through to P2025 as the spec requires.

## Issues — recorded, not fixed

1. **`deleteCompany` bypasses this guard entirely.** `src/lib/actions/companies.ts` calls
   `db.company.delete()` gated on `CRM_MANAGE_ROLES` with no invoiced-time check. `Ticket.company`
   is `onDelete: Cascade`, so deleting a company destroys its tickets and, through the same
   `TimeEntry.ticket` cascade, all their time entries. `Invoice.company` is also `Cascade`, so the
   invoices go too rather than being orphaned — a different blast radius, arguably more internally
   consistent, but still unguarded destruction of billing history. Its docstring warns about
   Sites/Contacts/Contracts/Assets and does **not** mention Tickets, TimeEntries or Invoices, so
   the warning understates the reach. Out of scope here; worth its own phase.
2. **`DEPLOYMENT.md` will be stale after 09-03** — it states `e2e/tickets.spec.ts` "has two
   `test.fixme` placeholders ... there is no delete button in the UI to drive them through." Both
   halves stop being true. **Handed to 09-03**, whose task 2 now owns that line and carries a
   negative-controlled check for it.
3. **Pre-existing lint warning** at `e2e/sla-tracking.spec.ts:48`, identical before and after. In
   09-01's tree, not this plan's.
