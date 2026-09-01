# Plan 04-03 Summary: Timer & Time Entry CRUD + UI

## Result
**Status**: Complete
**Wave**: 2
**Agent**: engineering-frontend-developer + testing-qa-verification-specialist
**Completed**: 2026-09-01T02:26:59Z

## Completed Tasks
1. Created `src/lib/validations/time-entry.ts` with `timeEntryUpdateSchema` (`isBillable: z.boolean()`, `notes: z.string().optional()`) and its inferred `TimeEntryUpdateInput` type.
2. Created `src/lib/actions/time-entries.ts` with all 4 Server Actions (`startTimer`, `stopTimer`, `updateTimeEntry`, `deleteTimeEntry`), each gated first by `requireRole(TIME_ENTRY_MANAGE_ROLES)`, with the app-level + P2002 double-timer guard, P2025 handling, and the invoiced-entry guard on update/delete.
3. Created `src/components/tickets/timer-control.tsx` (client component): renders "Start Timer" when no running entry, or a live elapsed-time display (ticking every 30s via `setInterval`) + "Stop Timer" when running, using `useTransition` for pending state and disabling the button during submission.
4. Created `src/components/tickets/time-entry-list.tsx`: a `Table`-based list of a ticket's time entries (technician, duration via `formatDuration`, billable checkbox, notes, invoiced badge, delete action), with all edit controls disabled/hidden for entries with a non-null `invoiceLineItemId` or for users without `timeentry:manage`. Empty-state row sets `colSpan={6}` matching the 6 columns.
5. Modified `src/app/(dashboard)/tickets/[ticketId]/page.tsx` to fetch the current user's running timer (across all tickets, via `userId`+`endedAt: null`), fetch the ticket's time entries (`orderBy: { startedAt: "desc" }`, including `user`), map them to `TimeEntryRow[]`, and render a new "Time Tracking" section with `TimerControl` (gated to `timeentry:manage`, with an informative message if the running timer belongs to a different ticket) and `TimeEntryList` (visible to all `ticket:view` users, `canManage` prop passed from `timeentry:manage`).

## Files Modified
- `src/lib/validations/time-entry.ts` — new, `timeEntryUpdateSchema`
- `src/lib/actions/time-entries.ts` — new, 4 Server Actions
- `src/components/tickets/timer-control.tsx` — new, client timer widget
- `src/components/tickets/time-entry-list.tsx` — new, time entry table
- `src/app/(dashboard)/tickets/[ticketId]/page.tsx` — modified, wires in Time Tracking section

## Verification Results
- `npx tsc --noEmit` output: only `src/app/layout.tsx(20,50): error TS2304: Cannot find name 'LayoutProps'.` — this is the documented pre-existing environment gap (missing generated `.next/types` in a fresh worktree), not introduced by this plan. No errors in any file touched by this plan.
- All grep-based existence/content checks passed (see table below).
- `git status --porcelain` confirms only this plan's 5 files were modified/created by this agent; other untracked entries (`.planning/STATE.md`, `src/app/api/qbo/`, `src/lib/actions/qbo-connection.ts`, `src/lib/qbo.ts`) belong to the concurrently-running Plan 04-04 agent in the same worktree, per the task briefing.

## Verification Commands
| Command | Exit Code | Result |
|---------|-----------|--------|
| `test -f src/lib/validations/time-entry.ts` | 0 | Pass |
| `test -f src/lib/actions/time-entries.ts` | 0 | Pass |
| `grep -q 'export async function startTimer' src/lib/actions/time-entries.ts` | 0 | Pass |
| `grep -q 'export async function stopTimer' src/lib/actions/time-entries.ts` | 0 | Pass |
| `grep -q 'export async function updateTimeEntry' src/lib/actions/time-entries.ts` | 0 | Pass |
| `grep -q 'export async function deleteTimeEntry' src/lib/actions/time-entries.ts` | 0 | Pass |
| `grep -q 'requireRole(TIME_ENTRY_MANAGE_ROLES)' src/lib/actions/time-entries.ts` | 0 | Pass |
| `npx tsc --noEmit` | 0 (excl. documented pre-existing layout.tsx error) | Pass |
| `test -f src/components/tickets/timer-control.tsx` | 0 | Pass |
| `grep -q '"use client"' src/components/tickets/timer-control.tsx` | 0 | Pass |
| `test -f src/components/tickets/time-entry-list.tsx` | 0 | Pass |
| `grep -q 'TimerControl' 'src/app/(dashboard)/tickets/[ticketId]/page.tsx'` | 0 | Pass |
| `grep -q 'TimeEntryList' 'src/app/(dashboard)/tickets/[ticketId]/page.tsx'` | 0 | Pass |
| `grep -q 'timeentry:manage' 'src/app/(dashboard)/tickets/[ticketId]/page.tsx'` | 0 | Pass |

## QA Self-Check Evidence
1. **`requireRole(TIME_ENTRY_MANAGE_ROLES)` is the literal first line of all 4 actions** — confirmed via `grep -n "^export async function" -A1 src/lib/actions/time-entries.ts`:
   - `startTimer(ticketId: string) {` → next line `const user = await requireRole(TIME_ENTRY_MANAGE_ROLES);`
   - `stopTimer(timeEntryId: string) {` → next line `await requireRole(TIME_ENTRY_MANAGE_ROLES);`
   - `updateTimeEntry(id: string, formData: FormData) {` → next line `await requireRole(TIME_ENTRY_MANAGE_ROLES);`
   - `deleteTimeEntry(id: string) {` → next line `await requireRole(TIME_ENTRY_MANAGE_ROLES);`
2. **`startTimer` returns a structured `{ error }`, never a thrown exception, on a running-timer conflict** — read directly from `src/lib/actions/time-entries.ts` lines 30-40 (app-level pre-check: `if (existingRunning) { return { error: ALREADY_RUNNING_ERROR }; }`) and lines 48-65 (`try { await db.timeEntry.create(...) } catch (err) { if (... err.code === "P2002") { return { error: ALREADY_RUNNING_ERROR }; } throw err; }`). Both paths return the same friendly message string rather than letting a raw Prisma error or unhandled exception surface.
3. **`stopTimer` always sets `endedAt` and `durationMinutes` together** — read directly: both fields are computed together (`const endedAt = new Date(); const durationMinutes = computeElapsedMinutes(entry.startedAt, endedAt);`) and written in a single `db.timeEntry.update({ data: { endedAt, durationMinutes } })` call — there is no code path that sets one without the other. An already-stopped entry (`entry.endedAt !== null`) short-circuits before this block and returns `{ error: "Timer is already stopped" }`, never re-writing either field.
4. **`updateTimeEntry`/`deleteTimeEntry` both check `invoiceLineItemId` before mutating** — `grep -n "invoiceLineItemId" src/lib/actions/time-entries.ts` shows the guard `if (entry.invoiceLineItemId !== null) { return { error: "This time entry has already been invoiced and cannot be edited." }; }` present in both functions (lines 141 and 178), in each case placed after the `findUnique` fetch and before any `update`/`delete` call.
5. **Ticket detail page gating matches `TIME_ENTRY_MANAGE_ROLES` (technician, dispatcher, admin)** — the page computes `const canManageTimeEntries = can(user.role, "timeentry:manage");` and `TIME_ENTRY_MANAGE_ROLES` in `src/lib/permissions.ts` is `["technician", "dispatcher", "admin"]`, matching `ROLE_PERMISSIONS` where only those 3 roles include `"timeentry:manage"` (sales and finance do not). `TimerControl` is rendered only inside `{canManageTimeEntries && (...)}`; `TimeEntryList` is always rendered but receives `canManage={canManageTimeEntries}` which the component uses to disable/hide all edit controls for sales/finance viewers.

## Key Decisions
- `startTimer`'s pre-check queries `db.timeEntry.findFirst({ where: { userId: user.id, endedAt: null } })` with no `ticketId` filter, per the plan's explicit instruction that "one running timer per user" is global across tickets, not per-ticket.
- The ticket detail page fetches the current user's running timer globally (not scoped to the current ticket) and passes `null` to `TimerControl` if that running entry belongs to a different ticket, additionally rendering an informational message so the technician understands why Start isn't available here rather than it looking broken.
- `TimeEntryList`'s billable toggle and notes field auto-save on change/blur (calling `updateTimeEntry` immediately) rather than requiring a separate "Save" button per row, to keep the row UI simple and consistent with the single-field-per-action pattern used elsewhere (e.g. `AssignmentControl`'s `onValueChange` autosave).
- Used the existing `src/components/ui/table.tsx` primitives for `TimeEntryList` (already present in the codebase) rather than a plain `<ul>`, since a tabular technician/duration/billable/notes layout benefits from column alignment; no new shadcn component or dependency was added.
- Notes/billable edits are sent as `FormData` through `updateTimeEntry(id, formData)` to match the established Server Action signature convention (`ticketId, formData` in `updateTicket`), rather than a bespoke plain-object signature.

## Issues Encountered
None. `src/lib/timer.ts` and `src/lib/permissions.ts` exported exactly the functions/constants this plan assumed (`computeElapsedMinutes`, `formatDuration`, `TIME_ENTRY_MANAGE_ROLES`), and `TimeEntry.userId`/`contractId` were confirmed nullable (`String?`/`User?`, `String?`/`Contract?`) directly in `prisma/schema.prisma`, so no BLOCKED condition was triggered.

## Requirements Covered
- Timer-based time entry against tickets
- Time entries are marked billable/non-billable and tied to the ticket's client contract
