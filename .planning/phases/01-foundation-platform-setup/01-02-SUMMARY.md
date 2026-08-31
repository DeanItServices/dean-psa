# 01-02 Summary: Docker + Database + Prisma Schema

**Status: Complete**

## What was done

### Task 1: Install backend dependencies and initialize Prisma schema — Complete
Ran `npm install prisma @prisma/client bcryptjs` and `npm install -D @types/bcryptjs`. All existing `package.json` entries from Plan 01-01 were preserved untouched; new deps/devDeps were appended additively.

`npm install prisma @prisma/client` initially resolved the `latest` dist-tag to **`8.0.0-rc.12`** (a release candidate), which was inconsistent with `@prisma/client`'s own resolution and represented an unpinned-RC risk on a production system's ORM. Corrected by explicitly installing `prisma@7.10.0 @prisma/client@7.10.0` (the newest **stable** published release at execution time) so both packages match on a stable major version.

Ran `npx prisma init --datasource-provider postgresql --no-skills`, which generated `prisma/schema.prisma`, `.env`, and (new in Prisma 7) `prisma7.config.ts`. Wrote the full `prisma/schema.prisma` (datasource, generator, `enum Role`, `model User`) per the plan's Task 1 spec, then continued directly into Task 2's models in the same file write (see below) since both tasks target the same file.

Wrote `.env` and `.env.example` with `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/msp_psa?schema=public"` as specified.

Fixed `.gitignore`: it already had a blanket `.env*` pattern (from Plan 01-01's create-next-app scaffold) which (a) did not satisfy this plan's exact-match verification (`grep -q "^\.env$"`) and (b) was inadvertently also ignoring `.env.example`, which the plan requires to be committed. Added an exact `.env` line plus a `!.env.example` negation exception, preserving the original `.env*` line rather than removing it.

### Task 2: Add Account/Session/VerificationToken models and generate migration — Complete
Extended `prisma/schema.prisma` with `model Account`, `model Session`, and `model VerificationToken` matching the `@auth/prisma-adapter` documented schema field-for-field (provider/providerAccountId/type/tokens on Account with `@@unique([provider, providerAccountId])`; sessionToken/userId/expires on Session; identifier/token/expires with `@@unique([identifier, token])` on VerificationToken).

Started a temporary Postgres container (`docker rm -f msp-psa-pg-temp` then `docker run --rm -d --name msp-psa-pg-temp -p 5432:5432 postgres:16-alpine ...`) since `docker-compose.yml` did not exist yet at this point in execution. Port 5432 was free (confirmed via `docker ps` before starting — only unrelated `psa-redis` and `fileflows-forge` containers were running).

Ran `npx prisma migrate dev --name init`, which produced `prisma/migrations/20260831114041_init/migration.sql` and applied it to the temporary database. Ran `npx prisma generate`, confirming the client generates to the classic `node_modules/@prisma/client` location. Stopped and confirmed removal of the temporary container afterward (`docker ps --filter "name=msp-psa-pg-temp"` returned no rows).

### Task 3: Create Docker Compose infra and Prisma client singleton — Complete
Created `Dockerfile` (3-stage: deps/builder/runner, `node:20-alpine`, `npx prisma generate` + `npm run build` in the builder stage, `npm start` in the runner stage, port 3000 exposed).

Created `docker-compose.yml` with `app` (builds from Dockerfile, port 3000, `DATABASE_URL` pointing at the `db` service hostname) and `db` (`postgres:16-alpine`, named volume `pgdata`, port 5432) services plus the top-level `volumes: { pgdata: {} }` block — exact content matches the plan's specified YAML.

Created `.dockerignore` excluding `node_modules`, `.next`, `.git`, `.env`, `.planning`, `npm-debug.log`.

Created `src/lib/db.ts` with the exact hot-reload-safe `PrismaClient` singleton pattern specified in the plan (`globalForPrisma` cache in non-production).

## Deviations from the plan (all environment/tooling-driven, not design choices)

1. **Prisma major version pinned to 7.10.0 instead of accepting `npm install`'s unpinned `latest` resolution.** The plan did not pin a version; `npm install prisma @prisma/client` resolved to `8.0.0-rc.12`, a pre-release. Re-installed both packages at `7.10.0` (latest stable) to avoid running a production PSA's database layer on an RC build. This is a risk-avoidance correction consistent with the Backend Architect role's "reliability-prioritized" mandate, not a scope change.
2. **`npx prisma init --datasource-provider postgresql` behavior differs from the plan's assumption.** Prisma 7's `init` now also generates `prisma7.config.ts` (a new required companion config file, not listed in `files_modified`) and no longer permits `url = env("DATABASE_URL")` inside the schema's `datasource` block — this is now a hard `P1012` validation error in Prisma 7 (`the datasource property url is no longer supported in schema files`), not merely a deprecation warning. Resolved by removing `url` from the `datasource` block and letting the auto-generated `prisma7.config.ts` (which Prisma itself generated, wiring `url: process.env["DATABASE_URL"]` via `dotenv/config`) supply the connection string instead. The `DATABASE_URL` env var name, `.env` file, and Postgres connection string format are all unchanged from the plan's intent — only the file that reads it changed, as mandated by the installed tool version. `prisma7.config.ts` was left in place as a required companion artifact (Prisma will not run `migrate`/`generate`/`validate` without it once `prisma init` has created it).
3. **Generator provider kept as classic `prisma-client-js`** (rather than Prisma 7's new default `prisma-client` with a `src/generated/prisma` output path) specifically to satisfy the plan's explicit `src/lib/db.ts` requirement of `import { PrismaClient } from "@prisma/client"`. Confirmed via `npx prisma generate` that the client generates to `node_modules/@prisma/client` as expected by that import.
4. **`.gitignore` gained two additional lines** beyond the plan's literal "append `.env` if missing" instruction: the exact `.env` line (for verification-command compliance) plus `!.env.example` (to un-ignore `.env.example`, which the pre-existing `.env*` glob from Plan 01-01 was inadvertently swallowing, contradicting this plan's requirement that `.env.example` be committable). Both changes are additive; the original `.env*` line was preserved.
5. **Added `db:migrate` and `db:seed` npm scripts to `package.json`**, per the plan's `<execution_contract>` "Allowed tools/actions" clause permitting this since `package.json` already existed from Plan 01-01. `db:seed` is a placeholder (`echo` command) as specified; actual seed logic is explicitly out of scope (Plan 01-03).

## Files created/modified
- `prisma/schema.prisma` (created) — datasource (no inline `url`), generator (`prisma-client-js`), `enum Role` (5 values: technician, dispatcher, sales, finance, admin), `model User`, `model Account`, `model Session`, `model VerificationToken`
- `prisma/migrations/20260831114041_init/migration.sql` (created)
- `prisma/migrations/migration_lock.toml` (created)
- `prisma7.config.ts` (created — required companion to schema.prisma in Prisma 7; supplies `DATABASE_URL` via `dotenv/config`)
- `.env` (created, gitignored)
- `.env.example` (created, committable)
- `.gitignore` (modified — added exact `.env` line and `!.env.example` negation)
- `Dockerfile` (created)
- `docker-compose.yml` (created)
- `.dockerignore` (created)
- `src/lib/db.ts` (created)
- `package.json` (modified — added `prisma`, `@prisma/client`, `bcryptjs` dependencies; `@types/bcryptjs` devDependency; `db:migrate`/`db:seed` scripts)
- `package-lock.json` (modified — dependency resolution, npm-managed)

## Verification command outputs

| Command | Result |
|---|---|
| `grep -q '"prisma"' package.json && grep -q '"@prisma/client"' package.json` | PASS |
| `test -f prisma/schema.prisma && grep -q 'enum Role' prisma/schema.prisma` | PASS |
| `grep -q "^\.env$" .gitignore` | PASS |
| `grep -q 'model Account' ... && grep -q 'model Session' ... && grep -q 'model VerificationToken' ...` | PASS |
| `test -d prisma/migrations` | PASS |
| `npx prisma validate` | PASS ("The schema at prisma\schema.prisma is valid") |
| `test -f docker-compose.yml && grep -q 'postgres:16-alpine' docker-compose.yml` | PASS |
| `test -f Dockerfile` | PASS |
| `test -f src/lib/db.ts && grep -q 'PrismaClient' src/lib/db.ts` | PASS |
| `docker compose config --quiet` | PASS (exit 0) |
| `grep -q 'technician' ... && grep -q 'dispatcher' ... && grep -q 'finance' ... && grep -q 'admin' ...` | PASS |

Plan-level `<verification>` checklist:
- [x] `docker compose config --quiet` exits 0
- [x] `npx prisma validate` exits 0
- [x] `prisma/schema.prisma` defines Role enum with exactly 5 values and User/Account/Session/VerificationToken models
- [x] `prisma/migrations/` contains at least one applied migration (`20260831114041_init`)
- [x] No files in `files_forbidden` were created or modified — confirmed via `git diff --stat -- src/app src/components src/lib/auth.ts src/lib/permissions.ts src/lib/session.ts src/middleware.ts tailwind.config.ts components.json` returning empty output, and `git status --short` showing no changes under `src/app/` or `src/components/`
- [x] Every planned task completed (no self-deferred work)

## Decisions made
1. Pinned Prisma/`@prisma/client` to stable `7.10.0` rather than accepting npm's `latest`-tag resolution of an `8.0.0-rc.12` pre-release, for production reliability.
2. Removed `url = env("DATABASE_URL")` from the Prisma schema's datasource block (now a hard validation error in Prisma 7) and relied on the tool-generated `prisma7.config.ts` to supply the same `DATABASE_URL` env var instead — preserving the plan's intended env-var-driven connection string while complying with the installed CLI's mandatory new config location.
3. Kept the classic `prisma-client-js` generator (not Prisma 7's new default `prisma-client` output-path generator) to satisfy the plan's explicit `@prisma/client` import requirement in `src/lib/db.ts`.
4. Added a `!.env.example` gitignore negation exception to fix a latent bug where Plan 01-01's blanket `.env*` pattern would have prevented `.env.example` from ever being committed.
5. Added `db:migrate`/`db:seed` npm scripts per the plan's explicitly sanctioned (not mandatory, but permitted) "Allowed tools/actions" clause.

## Issues/errors encountered (all resolved within this execution)
- `npm install prisma @prisma/client` resolved to an RC build — resolved by pinning to `7.10.0`.
- `npx prisma init --datasource-provider postgresql` succeeded but the generated schema/tooling shape differs from the plan's assumed classic Prisma behavior (new `prisma7.config.ts`, `url` no longer valid in schema) — resolved as described above.
- `npx prisma migrate dev --name init` failed once with `P1012` (`url` in datasource no longer supported) before the schema fix — re-ran successfully after removing the inline `url`.
- Pre-existing `.env*` gitignore glob from Plan 01-01 both failed this plan's exact-match verification and silently blocked `.env.example` from being committable — fixed additively.

No unresolved errors. No stop-gates were triggered (package.json existed, Docker was installed/running, Auth.js adapter schema fields were sourced from the plan's own explicit field list matching the documented `@auth/prisma-adapter` contract, and `prisma migrate dev` succeeded on the first attempt after the one schema fix).

## files_forbidden — confirmed untouched
Verified via `git diff --stat` against every forbidden path (`src/app/`, `src/components/`, `src/lib/auth.ts`, `src/lib/permissions.ts`, `src/lib/session.ts`, `src/middleware.ts`, `tailwind.config.ts`, `components.json`) returning no output, and `git status --short` showing no entries under `src/app/` or `src/components/`. None of `auth.ts`, `permissions.ts`, `session.ts`, or `middleware.ts` exist in the repo (correctly left for Plan 01-03).

## Post-execution amendment (coordinator, during Plan 01-03)

Plan 01-03's execution discovered that `src/lib/db.ts`'s `new PrismaClient()` (zero-arg) pattern throws `PrismaClientInitializationError` at runtime under the installed Prisma 7.10.0 — this version requires an explicit driver adapter, a runtime requirement that was never exercised during this plan's execution (only `migrate`/`generate`/`validate` were run here, none of which instantiate a client). With user authorization, the coordinator installed `@prisma/adapter-pg` + `pg` and updated `src/lib/db.ts` to pass a `PrismaPg` adapter to the constructor. This is a correctness fix to this plan's original deliverable, not a scope change — the singleton's public shape (`export const db: PrismaClient`) and hot-reload-safe caching behavior are unchanged. See Plan 01-03's SUMMARY.md "Resolution" section for full detail.
