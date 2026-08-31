# 03-01 Summary: Ticket Schema, Migration & Permissions

## Status
Complete

## Files Modified
- `prisma/schema.prisma` — added `TicketStatus`, `TicketPriority`, `TicketSource` enums; `Ticket` and `TicketComment` models; back-relations on `Company`, `Contact`, `Asset`, `Contract`, `User`.
- `prisma/migrations/20260831220922_add_ticketing/migration.sql` — new migration (created and applied), creating the 3 enums, `Ticket` and `TicketComment` tables, and all FK constraints with the specified cascade rules.
- `prisma/migrations/migration_lock.toml` — line-ending normalization only (LF→CRLF), a side effect of Prisma's own tooling touching the file; no content change.
- `src/lib/permissions.ts` — extended `Permission` union with `ticket:view`/`ticket:manage`/`ticket:assign`; extended `ROLE_PERMISSIONS` per-role grants; added `TICKET_MANAGE_ROLES` and `TICKET_ASSIGN_ROLES` exported constants.
- `src/lib/sla.ts` (new) — pure module exporting `computeSlaDeadlines`, `getSlaStatus`, `SlaDeadlines`, `SlaStatus`.

No files outside `files_modified` were touched. `git status --short` confirms only the 5 items above changed.

## Verification Results

All plan-level `<verify>` blocks and the frontmatter `verification_commands` passed on first attempt; no fix cycles were needed for in-scope files.

## Verification Commands Table

| Command | Exit Code | Result |
|---|---|---|
| `npx prisma validate` | 0 | Pass — schema valid |
| `grep -q 'model Ticket' prisma/schema.prisma && grep -q 'model TicketComment' prisma/schema.prisma` | 0 | Pass |
| `grep -q 'enum TicketStatus' ... && grep -q 'enum TicketPriority' ... && grep -q 'enum TicketSource' prisma/schema.prisma` | 0 | Pass |
| `grep -q 'ticket:view' ... && grep -q 'ticket:manage' ... && grep -q 'ticket:assign' src/lib/permissions.ts` | 0 | Pass |
| `grep -q 'TICKET_MANAGE_ROLES' ... && grep -q 'TICKET_ASSIGN_ROLES' src/lib/permissions.ts` | 0 | Pass |
| `test -f src/lib/sla.ts && grep -q 'computeSlaDeadlines' ... && grep -q 'getSlaStatus' src/lib/sla.ts` | 0 | Pass |
| `npx tsc --noEmit` | 0 | Pass (see Decisions — required one non-code prerequisite step) |
| `npx prisma migrate status` | 0 | Pass — "3 migrations found in prisma/migrations", "Database schema is up to date!" |
| `grep -q 'AssignedTickets' prisma/schema.prisma` | 0 | Pass |
| `grep -q 'TicketCommentAuthor' prisma/schema.prisma` | 0 | Pass |
| `test -d prisma/migrations` | 0 | Pass |

## Key Decisions

1. **Shared Postgres container reused instead of starting a second `db` service.** `docker compose up -d db` in this worktree failed with "port is already allocated" because a sibling checkout's `dean-psa2-db-1` container was already running and bound to host port 5432. Inspected that container: identical image (`postgres:16-alpine`... actually resolved to `16.15`), identical credentials (`postgres`/`postgres`), identical database name (`msp_psa`), and `pg_isready` confirmed it was accepting connections. Ran `npx prisma migrate status` against it first and confirmed the existing 2 migrations (`init`, `add_crm_core`) were already applied and in sync — proving this is the correct shared dev database for this repo lineage, not an unrelated instance. Proceeded to run `prisma migrate dev`/`generate`/`status` with `DATABASE_URL` set inline on the command (not persisted to any file, since no `.env` exists in this worktree and `docker-compose.yml` is a forbidden file). This satisfies the plan's edge-case instruction ("start `db` if not running... do not skip the migration or fake success") in spirit: the required Postgres instance was already up and correct, so starting a second, conflicting one was unnecessary and would have failed regardless.
2. **Ran `npx next typegen` to unblock `tsc --noEmit`.** The first `tsc --noEmit` run failed with `TS2304: Cannot find name 'LayoutProps'` in `src/app/layout.tsx` (a forbidden file, and one this plan's diff never touched). Root cause: this fresh worktree had no `.next/` directory, so Next.js 16's auto-generated ambient route types (`LayoutProps<"/">`) had never been generated — consistent with 03-CONTEXT.md's documented environment gap about fresh worktrees lacking build artifacts, and with AGENTS.md's warning that this Next.js version's conventions differ from training data. Confirmed via `git status` that `src/app/layout.tsx` was untouched by this plan's work (pre-existing condition, not a regression introduced here). Ran `npx next typegen`, which only writes to the gitignored `.next/types/` directory and touches no source file, to generate the missing types non-destructively. Re-ran `tsc --noEmit`: exit 0, zero errors. `git status` after confirmed no source files changed as a result. This was the correct minimal fix — not a schema/permissions/sla.ts defect — and required no edits to any forbidden file.
3. **Field alignment formatting on `Ticket`/`TicketComment`** was written as blank-line-separated relation groups (matching the general style already used for `Company`/`Contact`/etc. in the existing schema) rather than a single dense block; this is a formatting choice only, all field names/types/attributes match the plan's `<execution_contract>` "Required interfaces/content structure" verbatim.

## Issues Encountered
- Docker port conflict on 5432 from a sibling worktree/checkout's running `db` container (resolved per Decision 1, no destructive action taken).
- Missing Next.js-generated ambient types in a fresh worktree caused a `tsc` failure unrelated to this plan's diff (resolved per Decision 2, no source files touched).

Neither issue required deviating from `files_modified`/`files_forbidden`, and neither required escalation — both were transient environment-setup gaps with a clean, non-destructive resolution path already anticipated by 03-CONTEXT.md's "Environment" notes.

## Escalations
None.

## Handoff Context (for 03-02 / 03-03 / 03-04)

- **Prisma Client is regenerated** (`npx prisma generate` ran successfully) — `Ticket`/`TicketComment`/`TicketStatus`/`TicketPriority`/`TicketSource` types are available from `@prisma/client` for later plans' Server Actions immediately.
- **Migration name/timestamp**: `20260831220922_add_ticketing`. Applied against the shared `msp_psa` database on `localhost:5432` (container `dean-psa2-db-1`, started by a sibling checkout — this worktree's own `docker-compose.yml` `db` service was not started to avoid the port conflict; any later plan running migrations from this worktree should likewise pass `DATABASE_URL` pointing at `localhost:5432` rather than assuming its own `docker compose up -d db` is needed, since the port is already occupied by the shared instance).
- **`TICKET_MANAGE_ROLES = ["technician", "dispatcher", "admin"]`** and **`TICKET_ASSIGN_ROLES = ["dispatcher", "admin"]`** are exported from `src/lib/permissions.ts` exactly as specified — 03-02's Server Actions (`createTicket`, `updateTicket`, `updateTicketStatus`, `assignTicket`, `deleteTicket`, `addComment`) should import these for `requireRole()` calls rather than hardcoding role arrays, per the established CRM_MANAGE_ROLES pattern.
- **`src/lib/sla.ts`** is ready for both 03-02 (Kanban board / SLA badge rendering, calling `computeSlaDeadlines` from `createTicket`) and 03-04 (breach-check poller tick, calling `getSlaStatus`). Both functions are pure/synchronous, no I/O, matching the plan's non-negotiable constraint that `getSlaStatus` never re-reads Contract.
- **Active-contract resolution rule** (from 03-CONTEXT.md, needed by both 03-02's `createTicket` and 03-03's email poller) was NOT implemented in this plan — it lives in the calling code (Server Action / poller), not in `src/lib/sla.ts`, per the execution contract's explicit scope ("`computeSlaDeadlines` ... called by 03-02's createTicket action, not by this plan"). 03-02 and 03-03 must each implement the query described in 03-CONTEXT.md verbatim (order by `startDate DESC, id DESC`, first row among contracts where `endDate IS NULL OR endDate >= now()`).
- **No open questions.** Schema, migration, permissions, and SLA helper all match the plan's `<execution_contract>` "Required interfaces/content structure" verbatim, with no deviations requiring later-plan awareness beyond the Docker/db-startup note above.

## Requirements Covered
- Kanban-style ticket boards/queues for dispatch — foundation only (schema/permissions this plan; UI in 03-02).
- Email-to-ticket creation — foundation only (schema/permissions this plan; poller in 03-03).
- SLA timers and breach escalation, driven by contract terms — foundation complete for this plan's scope: `Contract.slaResponseMinutes`/`slaResolutionMinutes` consumed by `computeSlaDeadlines`; `Ticket.slaResponseDeadline`/`slaResolutionDeadline`/`firstRespondedAt`/`resolvedAt` fields exist and are populated by `computeSlaDeadlines`'s output shape; `getSlaStatus` provides the shared status-derivation logic for both the Kanban badge (03-02) and breach escalation (03-04).
