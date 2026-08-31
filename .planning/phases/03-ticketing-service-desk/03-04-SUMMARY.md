# 03-04 Summary: SLA Breach Escalation

## Status
Complete

## Files Modified
- `scripts/email-poller.ts` (extended, not replaced) — added a `checkSlaBreaches()` function and wired it into the existing `pollOnce()` tick, immediately after the email-ingestion block. No other file was created, modified, or deleted.

`git diff --stat` confirms exactly one file changed: `scripts/email-poller.ts` (151 insertions, 26 deletions — the deletions are re-indentation of the existing email-ingestion block, wrapped in an `if (messages.length > 0) { ... }` guard so the breach-check step below it always runs regardless of whether new email arrived this tick).

## Verification Results
All task-level `<action>` verification lines, the plan's `<verify>` block, the frontmatter `verification_commands` (except one addressed as a documented deviation below), and the QA-mindset checklist from the plan's `<verification>` section passed.

## Verification Commands Table

| Command | Result |
|---|---|
| `grep -Eq 'checkSlaBreaches\|breachCheck\|checkBreaches' scripts/email-poller.ts` | Pass (matches `checkSlaBreaches`) |
| `grep -q 'getSlaStatus' scripts/email-poller.ts` | Pass (imported and called) |
| `grep -q 'SLA BREACH' scripts/email-poller.ts` | Pass (`SLA_BREACH_MARKER = "[SLA BREACH]"`) |
| `npx tsc --noEmit` | Pass, exit 0 |
| `git diff --stat` scope check | Pass — only `scripts/email-poller.ts` changed |
| `grep -n "setInterval" scripts/email-poller.ts` (QA check: no second scheduler) | Pass — exactly one real `setInterval(` call, at line 446 inside pre-existing `startPolling()`; all other matches are comments |

**Frontmatter verification command deviation**: `grep -q 'notifiedAt\|breachNotified\|slaBreachNotifiedAt' scripts/email-poller.ts` (listed in the plan's YAML frontmatter `verification_commands`) does NOT match, because no such field/variable name was introduced. This is a deliberate, plan-mandated outcome, not a failure: the plan's own `<execution_contract>` Forbidden actions and `<stop_gates>` explicitly require a **comment-presence check** (querying for an existing `"[SLA BREACH]"`-marked `TicketComment`) instead of a new "notified" schema field, since adding a schema column would require a migration and is out of this plan's forbidden-files scope (`prisma/schema.prisma` is listed in `files_forbidden`). The task's own `<action>` block's `> verification:` lines (the authoritative verification set per execution instructions) do not include this notifiedAt grep at all — only `checkSlaBreaches|breachCheck|checkBreaches`, `getSlaStatus`, `SLA BREACH`, and `tsc --noEmit`, all of which pass. The frontmatter line appears to anticipate an alternative (schema-field-based) implementation strategy the plan body itself forbids; the comment-presence guard is the correct and only permitted implementation.

## Key Decisions

1. **Re-notification guard: comment-presence check, not a schema field.** Per the plan's explicit forbidden-actions/stop-gates, `checkSlaBreaches()` queries each open ticket's full `comments` list (`select: { body: true }`, no `take`/`orderBy` limiting it to "most recent") and uses `.some((c) => c.body.includes(SLA_BREACH_MARKER))` to check **every** existing comment before creating a new flag. No `prisma/schema.prisma` change was made.
2. **`SLA_BREACH_MARKER = "[SLA BREACH]"` extracted as a named constant** rather than inlined in the template string, so the guard's `.includes()` check and the comment-creation body both reference the exact same literal — eliminates any risk of the two use sites drifting out of sync.
3. **`checkSlaBreaches()` runs on every tick, not just ticks with new email.** The original `pollOnce()` had an early `return` when `messages.length === 0`. I moved the email-ingestion loop (including `saveWatermark`) inside an `if (messages.length > 0) { ... }` block and placed `await checkSlaBreaches();` after that block, unconditionally. Breach-checking queries existing `Ticket` rows and is unrelated to whether new Graph messages arrived — gating it behind "did email polling find messages" would have silently skipped breach detection on most ticks (a poller with no new mail is the common case), which would have violated the phase's escalation requirement. This was not explicitly spelled out in the plan's action text but follows directly from 03-CONTEXT.md's "SAME poller process, on the same tick" intent and the plan's own edge-case wording ("must simply stop appearing... on the next tick" implies breach-check runs every tick).
4. **Query filters `slaResolutionDeadline: { not: null }` at the database level**, in addition to `getSlaStatus()`'s own `"no_sla"` handling for null deadlines. This is defense-in-depth (both layers independently guarantee a null-deadline ticket is never flagged), matching the plan's edge-case requirement precisely, and also avoids fetching irrelevant rows.
5. **Per-ticket error isolation implemented at two levels**: the `db.ticket.findMany` query itself is wrapped in its own try/catch (a query-level failure skips the whole breach-check pass for this tick, logs, and returns — it does not throw up into `pollOnce()`), and each ticket's status-check/guard/comment-creation is wrapped in its own try/catch inside the `for` loop (a single ticket's failure is logged and the loop continues to the next ticket). Neither failure path re-throws, so `checkSlaBreaches()` can never crash `pollOnce()`, and `pollOnce()`'s own callers (`startPolling()`'s immediate call and its `setInterval` callback) already had a `.catch()` as a second line of defense from Plan 03-03.
6. **Breach comment body includes the human-readable ISO deadline**: `` `${SLA_BREACH_MARKER} This ticket has breached its SLA resolution deadline of ${deadline.toISOString()}.` `` — matches the plan's required content structure with the actual deadline interpolated.
7. **No second `setInterval` or scheduling construct was added.** `checkSlaBreaches()` is a plain exported `async function`, invoked via a single `await checkSlaBreaches();` statement inside the existing `pollOnce()` function body. The file's only `setInterval` call (in `startPolling()`, unchanged from Plan 03-03) still drives both email polling and breach-checking on the same 90-second tick.

## Issues Encountered
None requiring escalation. Implementation matched the plan's specified structure and Plan 03-03's handoff notes (`getSlaStatus` needed to be added as a new import; `pollOnce()`'s existing structure was confirmed to match `03-03-SUMMARY.md`'s description exactly) on first attempt. `npx tsc --noEmit` passed with zero errors on the first run.

## Escalations
None.

## QA Verification Specialist Checklist (performed by direct code reading, not claimed from memory)

- **Guard checks ALL existing comments, not just the most recent**: Confirmed. The `db.ticket.findMany` select includes `comments: { select: { body: true } }` with no `take`, `orderBy`, or limiting clause — every `TicketComment` row for the ticket is returned. The guard uses `ticket.comments.some(...)`, which iterates the entire array. (`scripts/email-poller.ts` lines 244-258, 278-280)
- **`slaResolutionDeadline: null` tickets are never flagged**: Confirmed via two independent layers. (1) The `findMany` where-clause filters `slaResolutionDeadline: { not: null }` (line 247), so null-deadline tickets never become candidates. (2) `getSlaStatus()` (`src/lib/sla.ts` lines 67-69) explicitly returns `"no_sla"` when `ticket.slaResolutionDeadline == null`, and `checkSlaBreaches()` skips anything where `status !== "breached"` (line 274). Both layers independently guarantee this.
- **A single ticket's comment-creation failure does not crash the tick**: Confirmed. Each ticket's full processing (status check, guard check, `db.ticketComment.create`) is inside its own `try { ... } catch (err) { console.error(...); }` within the `for` loop (lines 271-306); the catch block only logs and lets the loop continue — no re-throw. The `db.ticket.findMany` query is separately wrapped (lines 243-269) so even a query-level failure returns early from `checkSlaBreaches()` without throwing into `pollOnce()`.
- **No second `setInterval` or scheduling mechanism introduced**: Confirmed via `grep -n "setInterval" scripts/email-poller.ts` — exactly one real call, at line 446, inside the pre-existing `startPolling()` function (unchanged from Plan 03-03). `checkSlaBreaches()` is invoked synchronously (`await checkSlaBreaches();`) from inside `pollOnce()`, which is itself driven by that single `setInterval`. Breach-checking and email polling genuinely run on the same tick.

## Requirements Covered
- **SLA timers and breach escalation, driven by contract terms**: Fully delivered by this plan. `scripts/email-poller.ts`'s `checkSlaBreaches()` now runs on the same 90-second tick as email polling, queries open tickets (`status notIn [resolved, closed]`) with a non-null `slaResolutionDeadline`, uses the shared `getSlaStatus()` helper (`src/lib/sla.ts`, the exact same function driving the Kanban/detail-page `SlaBadge` from Plan 03-02) to detect newly-breached tickets, and flags each exactly once with an internal `"[SLA BREACH]"`-marked `TicketComment`, guarded against re-flagging via a full comment-history presence check. This closes out Phase 3's final open success criterion ("Escalation triggers... fire on SLA breach") using the same already-running poller process, with no second scheduled process introduced. Combined with Plan 03-01 (SLA deadline computation/schema) and Plan 03-02 (SLA badge display, manual ticket creation) and Plan 03-03 (email-to-ticket creation with SLA deadlines computed at creation), this requirement is now fully implemented end-to-end.
