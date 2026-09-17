# 09-03 — Delete confirmation dialog, real E2E cases, suite gate

**Status**: Complete with Warnings
**Wave**: 2
**Agent**: engineering-frontend-developer + testing-qa-verification-specialist
**Date**: 2026-09-17
**Files modified**: `src/components/tickets/ticket-delete-button.tsx` (new, 149 lines);
`src/app/(dashboard)/tickets/[ticketId]/page.tsx`; `e2e/tickets.spec.ts`; `DEPLOYMENT.md`.
`src/lib/actions/tickets.ts` byte-identical to HEAD.

## One `must_have` was unsatisfiable, and it is a planning defect

`must_haves[3]` read *"`npm run test:e2e` exits 0 with the new cases included."* It cannot.

`package.json` defines `test:e2e` as `--project=lifecycle --project=last-active-admin`, and
`playwright.config.ts` matches `tickets.spec.ts` to the **`advisory`** project only. Measured:

```
npx playwright test --project=lifecycle --project=last-active-admin --list | grep -c tickets.spec.ts
0
```

So the new cases land in a project the gate excludes by design — `DEPLOYMENT.md` says including
advisory "would make the gate permanently red and destroy its signal", which was true while
advisory had four failures. Closing this needs an edit to `package.json` or `playwright.config.ts`,
**neither of which was in this plan's `files_owned`** (09-01 owned the config). The agent did not
touch either and flagged it instead of quietly widening scope.

**This was the coordinator's error when writing the plan** — the criterion was written without
checking which project owns `tickets.spec.ts`. **Handed to 09-04**, which is the natural owner:
once it greens the advisory failures, advisory can join the gate in one line.

Evidence used instead: the three cases under `--project=advisory`, green in isolation, green twice
in the full advisory run, and **9/9 at `--repeat-each=3 --workers=4`, zero flaky**. Coordinator
re-ran independently: **3 passed**, and `npm run test:e2e` still **45 passed**.

## The component

`AlertDialog` + `useTransition` + inline `{ error }`, following `user-row-actions.tsx` — **including
its `catch`, which is byte-identical**.

> **CORRECTED (review cycle 1).** This paragraph previously read: "its `catch` deliberately **not**
> copied, because the actions it calls return rather than redirect." Both halves are false, and the
> correction is recorded here rather than silently overwritten because the false rationale is the
> kind a later reader would reuse.
>
> 1. The `catch` **was** copied. `user-row-actions.tsx`'s `handleDeactivate`/`handleReactivate`
>    catch blocks and `ticket-delete-button.tsx`'s are the same four lines —
>    `if (isNextRedirectError(err)) { throw err; } setError("Something went wrong. Please try
>    again.");`
> 2. The actions `user-row-actions.tsx` calls **do** redirect. Every one of them opens with
>    `requireRole(ADMIN_MANAGE_ROLES)` (`src/lib/actions/users.ts`), and `requireRole`
>    (`src/lib/session.ts:249`) calls `redirect("/unauthorized")` on a role miss and
>    `redirect("/change-password")` when `mustChangePassword` is set. Both throw `NEXT_REDIRECT`.
>
> So the rethrow is not a divergence from `user-row-actions.tsx` at all — it is the same guard, for
> the same reason, and it is load-bearing in both. What genuinely differs is only *which* path
> redirects on SUCCESS: `deleteTicket` ends in `redirect("/tickets")`, while the user-lifecycle
> actions return `{ error }` or `{ success }` and redirect only on the authorization path.

- **Refusal path**: the action RETURNS `{ error }` → rendered in a `<p role="alert">` placed
  *outside* `AlertDialogContent`, because Radix unmounts the dialog when its Action fires — an
  error inside it would vanish exactly when it had something to say.
- **Success path**: the action REDIRECTS → `isNextRedirectError(err)` rethrow, matching
  `company-form.tsx`.

The page gate uses `ADMIN_MANAGE_ROLES` — the *same constant* `requireRole` checks — so the UI
courtesy and the security boundary cannot drift. Dialog copy names both cascades by count with
correct singular/plural.

## The three cases

All build their own fixtures via Prisma (own company, dropped in `finally`) and use
`newIsolatedContext` for a per-context rate-limit bucket.

- **(a)** admin deletes an uninvoiced ticket → asserts navigation, no alert, row gone, time entries
  cascaded.
- **(b)** non-admin → **asserts server behaviour.** Captures a real `deleteTicket` invocation
  (action id never hardcoded), retargets it at a victim ticket, replays it with the technician's own
  cookies, and requires `redirectedTo === "/unauthorized"`, `result === null`, row still present.
  The hidden button is checked separately and labelled in-code as defence in depth, **not** the
  discriminator.
- **(c)** invoiced time → asserts the full refusal string, built from the same
  `Intl.DateTimeFormat` the action uses rather than hardcoding a date, so it tests the template and
  not the machine's locale.

## Negative controls — the real evidence

| # | Deliberate break | Case | Result |
|---|---|---|---|
| NC1 | remove the `isNextRedirectError` rethrow | (a) | **PASSED — did not fail.** Root-caused below |
| NC2 | `db.ticket.delete` → no-op | (a) | FAILED: `Expected: 0 / Received: 1` |
| NC3 | `ADMIN_MANAGE_ROLES` → `TICKET_MANAGE_ROLES` | (b) | FAILED: `Expected: "/unauthorized" / Received: "/tickets"` |
| NC4 | invoiced-time refusal disabled | (c) | FAILED: no alert, ticket deleted |
| NC5 | refusal string `" - "` → `"-"` | (c) | FAILED: `toHaveText` mismatch on one space |

**NC3 reproduced the Phase 7 defect and caught it.** With the role check deleted, the run reached
the redirect assertion — meaning **the hidden-button assertion passed green**. A UI-only test would
have certified a wide-open delete. `Received: "/tickets"` means the technician's delete actually
succeeded.

### NC1 did not fail, and the agent did not wave it through

It instrumented the catch with a `sessionStorage` marker: `catch marker = "ran:redirect"`. So the
catch does run on success and the error is a genuine `NEXT_REDIRECT` — the rethrow is correct and
load-bearing. The reason NC1 still passed: Next's router applies the `x-action-redirect` response
header independently of the thrown signal, so navigation happens either way and the component
unmounts before the swallowed error can paint.

**Stated plainly: case (a) cannot detect removal of that rethrow.** The line stays — it prevents a
`setError` firing on every successful delete — but no coverage is claimed that does not exist. NC2
is case (a)'s real control.

### Nothing survived

`git diff --stat src/lib/actions/tickets.ts` empty; md5sum matches HEAD; no `NC* BREAK` or probe
markers anywhere in `src/` or `e2e/`; temp specs and screenshots removed; DB shows 0 leftover
`E2E Delete %` companies — the `finally` cleanup held even through the failing NC runs.

## The sweep found a second stale passage that 09-02's missed

Running the plan's prescribed grep turned up **two** live non-`.planning` hits in `DEPLOYMENT.md`:

- **`:530`** the `test.fixme` line the plan named — removed.
- **`:697`** *"Ownership-scoped ticket delete has no UI entry point ... no delete button, menu, or
  affordance exists anywhere in the UI"* — **every clause now false.** 09-02's narrower sweep used
  different search terms and missed it; the plan's sweep catches it on `no delete button`.
  Rewritten to describe shipped behaviour.

The agent's `files_owned` said "DEPLOYMENT.md (the two-`test.fixme` line only)", so fixing `:530`
and leaving `:697` would have been literal compliance — and would have been the exact Phase 8
defect the retrospective named: a sweep that runs and then isn't acted on. It corrected both and
flagged the scope stretch rather than burying it. **The right call.** Post-sweep: zero
non-`.planning` hits remain.

## Verification

- `npx tsc --noEmit` → exit 0 *(regression guard, not a negative control)*
- `npm run lint` → exit 0, 0 problems *(same caveat)*
- `! grep -q 'test.fixme' e2e/tickets.spec.ts` → PASS *(negative-controlled: failed pre-change)*
- `grep -rq 'deleteTicket' src/components/` → PASS *(negative-controlled: failed pre-change)*
- `! grep -q 'there is no delete button in the UI' DEPLOYMENT.md` → PASS
- `npm run test:e2e` → **45 passed**, identical to the pre-edit baseline. **Contains 0 of the new
  cases** — proven, not assumed.
- `--project=advisory --grep delete` → **3 passed**; `--repeat-each=3 --workers=4` → 9 passed, 0 flaky
- `npm run test:e2e:advisory` → **4 passed / 4 failed** (was 1 passed / 4 failed / 2 skipped). The
  3 new cases are the new passes, the 2 skips are gone, the 4 failures are 09-01's identical
  pre-existing set — 09-04 owns them.
- Scope check: **Case A** — real dirty tree, 4 paths, `scope ok`; control B (synthetic `src/` path)
  → `SCOPE VIOLATION`, proving it fires; control C (empty tree) → vacuous `scope ok`.
- Environment: throwaway container on a unique port, destroyed; temporary `.env` removed; browser
  verified genuine (197 MB ELF, 0 symlinks) before use. **No symlinks created in `/opt/pw-browsers/`.**

## Issues — recorded, not fixed

1. **`npm run test:e2e` excludes `tickets.spec.ts`** — the unmet `must_have`. Handed to 09-04.
2. **Four pre-existing advisory failures** unchanged, 09-04's: `sla-tracking.spec.ts:33`
   (route-announcer), `tickets.spec.ts:118` (kanban drag — the unresolved one),
   `tickets.spec.ts:197` (429 signature), `time-entry-to-invoice.spec.ts:61` (hidden `<option>`).
3. **`deleteCompany` still bypasses the invoiced-time guard** — `Company → Ticket → TimeEntry` is
   all `onDelete: Cascade`, so deleting a company still destroys billing history unguarded.
4. **A transient Next dev-overlay "1 Issue" badge** appeared once during an interactive run, not
   reproduced across three clean probes (0 errors, 0 warnings, 0 page errors). Recorded rather than
   claiming zero issues.
5. **No audit record of ticket deletion** — no soft-delete, no archive, no log of who deleted what.
   Noted in the rewritten `DEPLOYMENT.md` paragraph; worth a phase alongside issue 3.
