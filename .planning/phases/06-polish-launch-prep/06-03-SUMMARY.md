# 06-03 Summary: Database Indexes

**Status: Complete**

## Files changed
- `prisma/schema.prisma` — added `@@index([companyId])` to `Contact`, `Contract`, `Asset` (matching `Ticket`'s existing style exactly); added `@@unique([qboInvoiceId])` to `Invoice`. No other schema change.
- `prisma/migrations/20260901190000_add_defense_in_depth_indexes/migration.sql` — new migration (new file, not modifying an existing one).

## What was done
1. Read `prisma/schema.prisma` in full. Confirmed `Invoice.qboInvoiceId String?` (line 297) and `Ticket`'s existing `@@index([companyId])` declaration style (line 230) to replicate exactly.
2. Added the 4 index declarations to `Contact`, `Contract`, `Asset`, and `Invoice` — no other model touched.
3. `npx prisma validate` passed after the edit.

## Deviation from the plan's literal command, and why
The plan's literal instruction was `npx prisma migrate dev --name add_defense_in_depth_indexes`. In this worktree there was no `.env` file and `DATABASE_URL` was unset, so `prisma migrate dev` failed immediately with `The datasource.url property is required` — a different failure mode than the plan's anticipated cases (not the `package.json` allowScripts side effect, not a data conflict). This is a stricter environment gap than prior phases' worktrees (Phase 5's worktree had a reachable `docker compose exec db`; this one had no running DB container and no `.env` at all).

Rather than either (a) hand-writing migration SQL from memory/guesswork, or (b) declaring BLOCKED for an environment-setup gap that was fixable, I brought up a real, disposable Postgres instance to get genuine Prisma-engine-computed output and live verification:
1. Started `db` service via `docker compose up -d db` with `DB_PORT=5435` (ports 5432 and 5434 were already in use by sibling worktrees/projects on this machine — 5435 avoided collision, consistent with the project's documented per-worktree `DB_PORT` convention).
2. Applied all 7 pre-existing migrations cleanly against the fresh DB (`prisma migrate status` confirmed baseline).
3. `prisma migrate dev` (and `--create-only`) both refused to run non-interactively in this sandboxed shell (`"Prisma Migrate has detected that the environment is non-interactive, which is not supported"`) — an unrelated CLI/TTY constraint, not a data or schema issue.
4. Used `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` (non-interactive, officially supported) to get the exact SQL the Prisma engine computes for the schema delta against the live DB. This produced:
   ```sql
   CREATE INDEX "Asset_companyId_idx" ON "Asset"("companyId");
   CREATE INDEX "Contact_companyId_idx" ON "Contact"("companyId");
   CREATE INDEX "Contract_companyId_idx" ON "Contract"("companyId");
   CREATE UNIQUE INDEX "Invoice_qboInvoiceId_key" ON "Invoice"("qboInvoiceId");
   ```
5. Wrote this engine-generated SQL verbatim into a new migration directory (`prisma/migrations/20260901190000_add_defense_in_depth_indexes/migration.sql`, naming convention and format matching all prior migrations in this repo).
6. Applied it via `prisma migrate deploy` (the standard non-interactive apply path) — succeeded cleanly, no unique-constraint conflict (fresh DB, no seed data).
7. Tore down the temporary DB container (`docker compose down`) after verification — no state left running.

No `package.json` side effect occurred this run (`git diff --stat -- package.json` was empty before and after).

## Mid-task anomaly (environment note, not a code issue)
Partway through, a `git diff` check showed my just-applied `prisma/schema.prisma` edits absent from the working tree (file matched HEAD) even though no destructive command had been run by this task. This coincided with a concurrent agent's `package.json` changes (`@playwright/test` / `test:e2e`, matching Plan 06-04's scope) appearing and then disappearing in the same window — consistent with another agent operating in this same shared worktree directory around the same time, not a self-inflicted revert. Re-applied the 4 index edits immediately, re-verified via a fresh `Read` before proceeding, and the edits held for the remainder of the task. Final `git status` shows `src/lib/actions/tickets.ts` and `src/middleware.ts` also modified (unstaged, not by this task) — these match Plan 06-02's known scope (ownership-scoped delete + rate limiting) and were left untouched, not staged, and not committed by this plan.

## Verification (live pg_indexes — Case A: live verification was possible)
A live DB connection **was** made available in this environment (self-provisioned via `docker compose up -d db` on port 5435, since none was running by default). Direct `pg_indexes` query after migration:

```
 tablename |                  indexname                  |                                                               indexdef
-----------+---------------------------------------------+--------------------------------------------------------------------------------------------------------------------------------------
 Asset     | Asset_companyId_idx                          | CREATE INDEX "Asset_companyId_idx" ON public."Asset" USING btree ("companyId")
 Contact   | Contact_companyId_idx                        | CREATE INDEX "Contact_companyId_idx" ON public."Contact" USING btree ("companyId")
 Contract  | Contract_companyId_idx                       | CREATE INDEX "Contract_companyId_idx" ON public."Contract" USING btree ("companyId")
 Invoice   | Invoice_companyId_periodStart_periodEnd_idx  | CREATE INDEX "Invoice_companyId_periodStart_periodEnd_idx" ON public."Invoice" USING btree ("companyId", "periodStart", "periodEnd")
 Invoice   | Invoice_qboInvoiceId_key                     | CREATE UNIQUE INDEX "Invoice_qboInvoiceId_key" ON public."Invoice" USING btree ("qboInvoiceId")
(plus each table's pkey index)
```

All 4 new indexes confirmed present and correctly typed (3 non-unique `@@index([companyId])`, 1 `@@unique` on `qboInvoiceId`).

**Nullable-uniqueness behavior verified empirically**: inserted two `Invoice` rows with `qboInvoiceId = NULL` under the same company — both inserts succeeded with no unique-constraint violation, confirming Postgres's standard behavior (multiple NULLs are not considered duplicates in a unique index). Rows were deleted immediately after verification; no test data left in any persistent store (the DB container itself was torn down).

## Verification commands run (plan's official list)
- `npx prisma validate` — exit 0, "The schema at prisma\schema.prisma is valid"
- `grep -rq 'qboInvoiceId' prisma/migrations/*/migration.sql` — PASS
- `grep -rq 'Contact' prisma/migrations/*/migration.sql` — PASS
- `grep -rq 'Contract' prisma/migrations/*/migration.sql` — PASS
- `grep -rq 'Asset' prisma/migrations/*/migration.sql` — PASS

## Files NOT touched (forbidden list respected)
`src/lib/crypto.ts`, `src/lib/qbo.ts`, `src/lib/actions/tickets.ts`, `src/middleware.ts`, `playwright.config.ts`, `package.json`, `src/components/**`, `src/app/**`, `.env.example` — none modified by this task. `git diff --stat -- package.json` confirmed empty at time of commit staging.

## Issues/errors
None blocking. The non-interactive-TTY limitation of `prisma migrate dev`/`--create-only` in this sandboxed environment required using `prisma migrate diff` + `migrate deploy` as the non-interactive equivalent path — functionally identical output (engine-computed SQL, applied and tracked in `_prisma_migrations` the same way), just a different CLI invocation sequence to work around the missing TTY.
