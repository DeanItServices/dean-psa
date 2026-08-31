# 03-02 Summary: Ticket CRUD + Kanban Board + SLA Display

## Status
Complete

## Files Modified
- `src/lib/validations/ticket.ts` (new) — zod schemas (`ticketSchema`, `ticketUpdateSchema`) for ticket create/update input.
- `src/lib/actions/tickets.ts` (new) — `createTicket`, `updateTicket`, `updateTicketStatus`, `assignTicket`, `deleteTicket`, plus an internal `resolveActiveContract` helper implementing the locked Active-contract resolution rule.
- `src/lib/actions/ticket-comments.ts` (new) — `addComment`.
- `src/components/tickets/sla-badge.tsx` (new) — shared `SlaBadge` component, sole SLA-status rendering implementation.
- `src/components/tickets/kanban-board.tsx` (new) — `@dnd-kit/core` `DndContext`-based board, keyboard-accessible.
- `src/components/tickets/kanban-column.tsx` (new) — per-status column with `SortableContext` and visible empty-state message.
- `src/components/tickets/ticket-card.tsx` (new) — draggable/read-only Kanban card using `useSortable`.
- `src/components/tickets/ticket-form.tsx` (new) — create/edit ticket form; also exports `AssignmentControl` (see Decisions).
- `src/components/tickets/ticket-comment-form.tsx` (new) — comment/internal-note form.
- `src/app/(dashboard)/tickets/page.tsx` (new) — Kanban board route.
- `src/app/(dashboard)/tickets/new/page.tsx` (new) — create-ticket route.
- `src/app/(dashboard)/tickets/[ticketId]/page.tsx` (new) — ticket detail route.
- `src/components/nav/app-sidebar.tsx` — added `ticket:view`-gated Tickets nav link, following the Clients item's exact pattern.
- `package.json` — added `@dnd-kit/core`, `@dnd-kit/sortable` (additive merge; no existing entries removed).
- `src/components/ui/badge.tsx` (new, via `npx shadcn@latest add badge`) — explicitly authorized by the execution contract's allowed-tools list.
- `package-lock.json` — unavoidable side effect of `npm install`.

No files outside this scope were touched. `git status --short` confirms no forbidden files (`prisma/schema.prisma`, `prisma/migrations/**`, `src/lib/permissions.ts`, `src/lib/sla.ts`, `scripts/**`, `docker-compose.yml`, `src/lib/session.ts`, `src/lib/db.ts`) were modified.

## Verification Results
All plan-level `<verify>` blocks and frontmatter `verification_commands` passed on first attempt; no fix cycles were needed.

## Verification Commands Table

| Command | Exit Code | Result |
|---|---|---|
| `npx shadcn@latest add badge` | 0 | Pass — created `src/components/ui/badge.tsx` |
| `npm install @dnd-kit/core @dnd-kit/sortable` | 0 | Pass — additive; re-read `package.json` immediately before running, unchanged from earlier read |
| `grep -q 'createTicket'/'updateTicketStatus'/'assignTicket'/'deleteTicket' tickets.ts` | 0 | Pass |
| `grep -q 'TICKET_MANAGE_ROLES'/'TICKET_ASSIGN_ROLES' tickets.ts` | 0 | Pass |
| `grep -q 'computeSlaDeadlines' tickets.ts` | 0 | Pass |
| `grep -q 'addComment' ticket-comments.ts` | 0 | Pass |
| `grep -q 'getSlaStatus' sla-badge.tsx` | 0 | Pass |
| `grep -q 'DndContext' kanban-board.tsx` | 0 | Pass |
| `grep -q '@dnd-kit/core' package.json` | 0 | Pass |
| `grep -q 'isNextRedirectError' ticket-form.tsx` | 0 | Pass |
| `test -f` for all 3 route pages | 0 | Pass |
| `grep -q 'ticket:view' app-sidebar.tsx` | 0 | Pass |
| `npx tsc --noEmit` (run after each task, 3x, and once final) | 0 | Pass every time |

## QA Verification Pass (skeptical re-check before declaring complete)

Per this plan's dual-role assignment (engineering-frontend-developer build + testing-qa-verification-specialist verification), the following were independently grepped/read after the build to confirm, not merely assumed:

1. **Exact role-gate constant per action** — read `tickets.ts` lines around each `export async function`:
   - `createTicket` → `TICKET_MANAGE_ROLES` ✓
   - `updateTicket` → `TICKET_MANAGE_ROLES` ✓
   - `updateTicketStatus` → `TICKET_MANAGE_ROLES` ✓
   - `assignTicket` → `TICKET_ASSIGN_ROLES` ✓ (confirmed NOT `TICKET_MANAGE_ROLES`)
   - `deleteTicket` → `TICKET_MANAGE_ROLES` ✓
   - `addComment` (ticket-comments.ts) → `TICKET_MANAGE_ROLES` ✓
2. **Empty-state Kanban columns** — `kanban-column.tsx` renders `<p>No tickets</p>` inside the droppable container when `tickets.length === 0`, not blank space. Confirmed by grep and read.
3. **Table empty-state colSpan** — no `Table`/`TableCell` component is used anywhere in the new tickets scope (Kanban uses cards; comments use a `<ul>` list). Confirmed via `grep -rn "colSpan|TableCell" src/app/(dashboard)/tickets/ src/components/tickets/` returning zero matches — the requirement is vacuously satisfied because no table exists in this plan's scope to have the bug.
4. **SlaBadge single implementation** — `grep -rn "SlaBadge"` shows exactly one `export function SlaBadge` (in `sla-badge.tsx`) and two import/usage sites: `ticket-card.tsx` (Kanban) and `[ticketId]/page.tsx` (detail page), both importing rather than reimplementing. `grep` for any other `getSlaStatus` definition/usage outside `sla-badge.tsx` and `src/lib/sla.ts` returned zero matches.
5. **Keyboard accessibility of drag-and-drop** — `kanban-board.tsx` imports `KeyboardSensor` and includes it in `useSensors(...)` alongside `PointerSensor`, using `sortableKeyboardCoordinates`. Not disabled or omitted.
6. **createTicket SLA computation timing** — confirmed by reading the full function body: `computeSlaDeadlines` is called once, synchronously, before the single `db.ticket.create` call, using the resolved contract's SLA minute fields and `new Date()` as the creation timestamp. No later read-time recomputation exists anywhere (`getSlaStatus`, the only other SLA-related function used at read time, only derives a status label, never deadlines).
7. **Active-contract resolution rule fidelity** — `resolveActiveContract` in `tickets.ts` implements `where: { companyId, OR: [{ endDate: null }, { endDate: { gte: now } }] }, orderBy: [{ startDate: "desc" }, { id: "desc" }]`, matching 03-CONTEXT.md's locked rule verbatim (same predicate, same two-level order, first row taken via `findFirst`).
8. **P2025 handling** — `updateTicket`, `updateTicketStatus`, `assignTicket`, `deleteTicket` all wrap their `db.ticket.*` calls in try/catch checking `err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025"`, returning `{ error: "Ticket not found" }` rather than throwing.
9. **isNextRedirectError usage** — present in both `ticket-form.tsx` (createTicket redirects) and `ticket-comment-form.tsx` catch blocks, matching the Phase 2 convention.
10. **Sidebar gating pattern** — the new Tickets `<li>` uses `{can(role, "ticket:view") && <Link href="/tickets">...}`, byte-for-byte structurally identical to the existing Clients item; no hardcoded role-name comparison introduced.
11. **git diff scope** — `git status --short` shows only files within `files_modified` (plus the explicitly-authorized `badge.tsx` and the unavoidable `package-lock.json`); zero forbidden files touched.

## Key Decisions

1. **`AssignmentControl` lives inside `ticket-form.tsx` rather than a new file.** The plan's `files_modified` list does not include a separate assignment-control component path, and Next.js does not allow mixing a `"use client"` interactive control with an async Server Component data-fetch in the same file (the detail page must remain a Server Component to `await db.ticket.findUnique(...)`). Since `ticket-form.tsx` is already `"use client"` and already in `files_modified`, `AssignmentControl` was added as a second named export from that file, importing `assignTicket` directly. This stays strictly within the plan's file-scope constraint while satisfying the detail page's requirement for a `ticket:assign`-gated assignment control calling `assignTicket`.
2. **Kanban optimistic update with rollback.** `kanban-board.tsx` updates local state immediately on drop (for responsive UX) and calls `updateTicketStatus` server-side; if the action returns `{ error }` (e.g. P2025 from a concurrently-deleted ticket), the local state is rolled back to its pre-drop value. This satisfies the plan's P2025-handling requirement for `updateTicketStatus` without leaving the board in a visually inconsistent state.
3. **`SlaBadge` variant/color mapping** uses shadcn `Badge`'s existing `default`/`secondary`/`destructive`/`outline` variants plus small Tailwind color overrides for `on_track`/`approaching`/`met` (green/yellow) since the base `Badge` component has no dedicated "success"/"warning" variant. `breached` uses the unmodified `destructive` variant. This keeps the five `SlaStatus` values (`no_sla`, `on_track`, `approaching`, `breached`, `met`) visually distinct per the plan's requirement without adding a new badge variant to the shared `ui/badge.tsx` (out of this plan's `files_modified` scope to modify further than the shadcn-generated default).
4. **`resolveActiveContract` implemented locally in `tickets.ts`**, not in `src/lib/sla.ts` (forbidden/read-only for this plan) — matches 03-01-SUMMARY.md's explicit handoff note that this rule "lives in the calling code (Server Action / poller), not in `src/lib/sla.ts`." Plan 03-03's poller must independently implement the identical query per 03-CONTEXT.md's shared-rule instruction.
5. **Company/contact/asset/user select lists in `ticket-form.tsx` are unfiltered by role** (all users listed as potential assignees, matching the plan's "assignee list is all users" instruction) — the create-ticket page itself is already gated to `ticket:manage` users, and `assignedToId` is optional at creation time (dispatch typically assigns after intake).
6. **Detail page shows a plain-text "Assigned to: X" line (not a disabled select) for viewers without `ticket:assign`**, rather than rendering `AssignmentControl` in a disabled state — avoids shipping an interactive-looking control to users who can never use it, consistent with the plan's read-only framing for non-manage/non-assign roles.

## Issues Encountered
None. All Wave 1 (Plan 03-01) outputs — `Ticket`/`TicketComment` models, `TICKET_MANAGE_ROLES`/`TICKET_ASSIGN_ROLES`, `src/lib/sla.ts`'s `computeSlaDeadlines`/`getSlaStatus` — matched this plan's assumptions exactly on inspection; no stop-gate conditions were triggered. `package.json` was unchanged between the initial context read and the immediately-pre-install re-read, confirming Plan 03-03 had not yet run in this same wave dispatch — the additive `npm install` proceeded without needing a merge-conflict resolution.

## Escalations
None.

## Handoff Context (for 03-03 / 03-04)

- **`resolveActiveContract`'s query shape** (in `src/lib/actions/tickets.ts`) is the reference implementation of the locked Active-contract resolution rule: `db.contract.findFirst({ where: { companyId, OR: [{ endDate: null }, { endDate: { gte: now } }] }, orderBy: [{ startDate: "desc" }, { id: "desc" }] })`. Plan 03-03's email poller must implement the identical predicate/ordering (not necessarily the identical Prisma call shape, but the identical resulting query semantics) to guarantee cross-implementation SLA-term consistency, per 03-CONTEXT.md.
- **`TicketStatus`/`TicketPriority`/`TicketSource` enum values are consumed as Prisma-generated string literal unions** (`"new" | "in_progress" | "waiting_on_client" | "resolved" | "closed"`, etc.) throughout the new UI and action code — no local re-declaration of these enums exists; import `TicketStatus` etc. from `@prisma/client` as this plan's code does.
- **`getSlaStatus` is called only in `src/components/tickets/sla-badge.tsx`** within this plan's scope. Plan 03-04's breach-check poller tick should import it directly from `@/lib/sla` (not from `sla-badge.tsx`, which is a React component) for its own breach-detection logic, per `src/lib/sla.ts`'s own module doc comment.
- **No open questions or deviations requiring 03-03/03-04 awareness** beyond the shared Active-contract resolution rule note above.

## Requirements Covered
- Kanban-style ticket boards/queues for dispatch — delivered: `/tickets` renders a column per `TicketStatus` in the fixed order (`new, in_progress, waiting_on_client, resolved, closed`), drag-and-drop (pointer + keyboard) reassigns status via `updateTicketStatus`, read-only for non-`ticket:manage` roles.
- SLA timers and breach escalation, driven by contract terms — SLA *display* delivered for this plan's scope: `SlaBadge` renders `getSlaStatus`'s five states identically on Kanban cards and the detail page, driven by `slaResponseDeadline`/`slaResolutionDeadline` computed once at ticket creation via `computeSlaDeadlines`. Proactive breach *escalation* (notification/flagging) remains Plan 03-04's scope, as planned.
- (Partial, foundation for) Email-to-ticket creation — not this plan's scope (Plan 03-03); `source: "manual"` is set on all tickets created through this plan's UI, leaving `"email"` as a valid but currently-unused enum value for 03-03 to populate.
