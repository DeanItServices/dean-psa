# 07-01 Summary — Schema, session types, and seed

**Status**: Complete
**Wave**: 1
**Agent**: engineering-backend-architect
**Date**: 2026-09-02

## What was done

Added the two boolean columns the rest of Phase 7 depends on, augmented the next-auth `User`
interface correctly, and made the seed write both fields in both branches of its upsert.

## Files changed

| File | Change |
|------|--------|
| `prisma/schema.prisma` | `User` gains `isActive Boolean @default(true)` and `mustChangePassword Boolean @default(false)` adjacent to `role`. Surrounding field block re-aligned (whitespace only, `prisma format` output) because `mustChangePassword` is now the longest field name. |
| `prisma/migrations/20260902153237_add_user_activation_fields/migration.sql` | New additive migration, generated and applied by Prisma. |
| `types/next-auth.d.ts` | `User` gains two **optional** booleans. `Session` and `JWT` untouched. |
| `prisma/seed.ts` | Upsert sets `isActive: true` / `mustChangePassword: false` in `create` **and** in `update` (replacing `update: {}`). |

## Migration SQL

```sql
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
```

Exactly two `ADD COLUMN`s with defaults. Nothing destructive, no backfill needed — Postgres
applies the defaults to existing rows at `ALTER TABLE` time, so every pre-existing user is
active and unblocked.

## Verification

Run by the agent and **independently re-run by the orchestrator**:

| Check | Result |
|---|---|
| `npx prisma migrate status` (pre-flight, before any edit) | "Database schema is up to date!", 8 migrations, no drift — **stop gate did not fire** |
| `npx prisma validate` | valid |
| `npx tsc --noEmit` | exit 0 |
| `grep -c 'mustChangePassword' prisma/seed.ts` | 2 (both branches) |
| `git diff --name-only HEAD -- src/ e2e/ docker-compose.yml package.json` | empty — no forbidden file touched |
| `types/next-auth.d.ts` diff | only Session/JWT mention is a comment; both interfaces unchanged |

Baseline `tsc` was confirmed clean (exit 0) before dispatch, so the passing typecheck is
meaningful rather than inherited.

`migrate dev` was run with stdin redirected from `/dev/null` so a reset prompt could not have
been accepted even if offered.

## Decisions

- **Field placement**: immediately after `role`, per the plan. Cost: an 11-line whitespace
  re-alignment of the contiguous field block. No existing field's name, type or attributes
  changed.
- **Migration name**: `add_user_activation_fields`; Prisma assigned timestamp `20260902153237`.
- **No index** on either column, per the plan's forbidden actions.
- **Explanatory comments added** to `types/next-auth.d.ts` and `prisma/seed.ts` recording why
  the fields are optional and why `update: {}` was replaced. Slightly beyond minimal diff;
  kept because the rationale is non-obvious and was expensively derived.

## Substituted verification

The agent could not run a direct `psql` column read — the worktree sandbox refused the
`. ./.env` sourcing construct, and it declined to put database credentials on a command line
to work around it. `prisma migrate status` reporting sync against 9 migrations is the
authoritative equivalent. Recorded here rather than glossed.

## Auto-Remediation

None. No command failed.

## Risks and follow-ups

1. **The deploy-ordering hazard is now live.** `authorize()` (`src/auth.ts:50`) does
   `findUnique` with no `select`, so Prisma requests every column. Once 07-02 ships, any
   environment where this migration has not run raises **P2022** on every request →
   `getCurrentUser()` fails closed → `loginAction` reports "Invalid email or password" to
   every user including every admin. **The migration must be applied before the app restarts.**
   07-06 owns documenting this in `DEPLOYMENT.md`.
2. **The dev database now has the columns.** Committed here along with the migration
   directory, so disk and database stay in agreement. Had this branch been discarded
   uncommitted, the database would have retained a `_prisma_migrations` row for a migration
   no longer on disk — the exact drift this plan's own stop gate guards against.
3. **`prisma7.config.ts` governs Prisma CLI behaviour** (every command logged loading it).
   Not modified, not in scope — noted because later plans' migration and seed behaviour
   depends partly on it, not solely on `package.json`.
4. **The seed's `update` branch now overwrites operator intent**: re-seeding forcibly
   reactivates any deactivated `@mspdemo.local` fixture account and clears its
   `mustChangePassword`. This is the plan's explicit requirement (it keeps the E2E fixture
   loginable) and the accounts are dev-only, but it is a real behavioural change.

## Unblocks

Wave 2 — 07-02 (session freshness), 07-03 (user lifecycle actions), 07-04 (change-password
route) all depend on this plan and can now run in parallel.
