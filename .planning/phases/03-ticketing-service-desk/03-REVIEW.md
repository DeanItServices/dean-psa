# Phase 3: Ticketing & Service Desk — Review Summary

## Result: PASSED

**Cycles Used**: 2 of 3
**Reviewers**: testing-qa-verification-specialist, engineering-backend-architect, engineering-frontend-developer (dynamic review panel, 3 reviewers across 2 divisions)
**Completed**: 2026-08-31

## Findings Summary

| Metric               | Count |
|-----------------------|-------|
| Total findings (cycle 1) | 13 (4 WARNING, 9 SUGGESTION) |
| Blockers found        | 0     |
| Blockers resolved      | N/A   |
| Warnings found         | 4     |
| Warnings resolved      | 4     |
| Suggestions (noted, cycle 1) | 9 (not required) |
| New findings (cycle 2) | 1 (SUGGESTION, not required) |

## Findings Detail

| #  | Severity   | File                                              | Issue                                                                                  | Fix Applied                                                                                      | Cycle Fixed |
|----|------------|----------------------------------------------------|-----------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------|-------------|
| 1  | WARNING    | `src/lib/actions/tickets.ts` (`createTicket`)      | Any `TICKET_MANAGE_ROLES` user (incl. technicians) could set `assignedToId` at creation, bypassing the `TICKET_ASSIGN_ROLES` (dispatcher/admin-only) gate | `requireRole`'s return captured; `assignedToId` only honored when `TICKET_ASSIGN_ROLES.includes(user.role)`, silently nulled otherwise (creation still succeeds) | 1           |
| 2  | WARNING    | `src/lib/actions/tickets.ts` (`updateTicket`) / `src/lib/validations/ticket.ts` | `ticketUpdateSchema` validated `assignedToId`/`contractId`/`status` that `updateTicket` never persisted — validate/persist drift, dead field, landmine for a future edit route | `ticketUpdateSchema` narrowed via `ticketSchema.omit({ assignedToId, contractId, status })` to match exactly what `updateTicket` writes | 1           |
| 3  | WARNING    | `prisma/schema.prisma` (`Ticket.firstRespondedAt`) / `src/lib/actions/ticket-comments.ts` | `firstRespondedAt` defined and typed everywhere but never written — response-SLA half of the feature was inert | `addComment` now runs inside `db.$transaction`; a non-internal comment triggers a guarded `updateMany({ where: { firstRespondedAt: null } })` so only the first response sets it, atomically | 1           |
| 4  | WARNING    | `src/components/tickets/kanban-board.tsx`          | Optimistic-update race: a `useEffect` prop-sync could clobber an in-flight `updateTicketStatus` mutation, risking a visible flicker or lost update | Added `isMutatingRef` (gates the effect while a mutation is pending) + `pendingTicketsRef` (captures and replays any newer prop after the mutation settles) | 1           |
| 5  | SUGGESTION | `src/components/tickets/ticket-form.tsx`           | Technicians still see and can interact with the Assignee select on ticket creation even though the value is now silently discarded server-side (Finding 1's fix) | Not required — noted for optional follow-up (hide/disable the field client-side for non-`ticket:assign` roles) | — (deferred) |

## Reviewer Verdicts

| Reviewer | Cycle 1 | Cycle 2 | Key Observations |
|---|---|---|---|
| testing-qa-verification-specialist | NEEDS WORK | **PASS** | Independently re-ran `tsc --noEmit`/`prisma validate` both cycles; confirmed all 4 fixes via direct code evidence, ran all 6 required regression checks clean, surfaced the response-SLA gap (Finding 3) that neither other reviewer initially found |
| engineering-backend-architect | NEEDS WORK | **PASS** | Found the highest-severity issue (Finding 1, RBAC bypass); cycle 2 traced `requireRole`'s return-type wiring end-to-end to rule out a "silently always-null" false-positive fix, verified `$transaction` semantics against the actual `@prisma/adapter-pg` driver, and confirmed Postgres `READ COMMITTED` row-locking makes the `firstRespondedAt` guard race-safe |
| engineering-frontend-developer | NEEDS WORK | **PASS** | Found Finding 4 (Kanban race) with correct root-cause analysis; cycle 2 traced all 4 required scenarios (normal drag, concurrent prop arrival, rollback path, stale-ref guard) against the fix and confirmed each holds |

## Suggestions (Not Required)

From cycle 1 (9 total, not required for approval):
- Dead/unreachable ticket-edit code path in `ticket-form.tsx` (no `/tickets/[ticketId]/edit` route exists yet)
- Kanban board has no responsive breakpoint for narrow viewports (desktop-first by design, flagged for confirmation)
- Whole-card drag handle creates overlapping focusable regions with the nested ticket-subject link
- `SlaBadge` uses hardcoded Tailwind colors instead of theme tokens (no dark-mode adaptation)
- No `loading.tsx`/`error.tsx` for the tickets route group (consistent with a pre-existing Phase 2 gap, not a new regression)
- Missing `.gitignore` entry for the email-poller's `.email-poller-state.json` watermark file
- `tsx` installed as a devDependency but required at runtime by the `email-poller` Docker service — fragile if a future Dockerfile change adds `--omit=dev`
- Sender-to-Contact email matching in the poller uses `findFirst` with no explicit `orderBy`, non-deterministic if two Contacts share an email across companies
- `scripts/email-poller.ts` has no escalating-failure signal for persistent (non-429) Graph API errors — a broken mailbox connection fails silently to console logs only

From cycle 2 (1 new):
- Finding 5 above (Assignee field UX inconsistency for technicians on the create form)

Candidates for Phase 6 polish or earlier if Phase 4/5 need them.

## Cycle Delta

### Progression Summary

| Metric | Cycle 1 | Cycle 2 (Final) |
|--------|---------|-------|
| Total findings | 13 | 1 |
| BLOCKER | 0 | 0 |
| MUST-FIX (WARNING+) | 4 | 0 |
| SUGGESTION | 9 | 1 |

### Findings Resolved (fixed between cycles)

| Finding | File | Resolved In |
|---------|------|-------------|
| RBAC bypass — `createTicket` allows unrestricted `assignedToId` | `src/lib/actions/tickets.ts` | Cycle 1 |
| Validate/persist drift — `updateTicket` silently drops fields | `src/lib/actions/tickets.ts`, `src/lib/validations/ticket.ts` | Cycle 1 |
| `firstRespondedAt` never written — response-SLA inert | `src/lib/actions/ticket-comments.ts` | Cycle 1 |
| Kanban optimistic-update race condition | `src/components/tickets/kanban-board.tsx` | Cycle 1 |

### Findings New (appeared in later cycles)

| Finding | File | Appeared In | Severity |
|---------|------|-------------|----------|
| Assignee field UX inconsistency for technicians | `src/components/tickets/ticket-form.tsx` | Cycle 2 | SUGGESTION |

### Findings Unchanged (persisted across all cycles)

None — all 4 must-fix findings were resolved in the single fix cycle; no finding persisted unresolved.

## Verification

Independently re-run and confirmed clean by all 3 reviewers, across both review cycles:
- `npx tsc --noEmit` — exit 0, zero errors, every time
- `npx prisma validate` — schema valid, every time

## Files Changed in This Review (fix cycle 1, commit `0c0da00`)

- `src/lib/actions/tickets.ts`
- `src/lib/actions/ticket-comments.ts`
- `src/lib/validations/ticket.ts`
- `src/components/tickets/kanban-board.tsx`
