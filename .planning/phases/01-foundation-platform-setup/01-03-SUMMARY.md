# 01-03 Summary: Auth + RBAC Core

**Status: Complete** (resolved post-execution — see Resolution section at the end)

**Original execution status: Partial** (BLOCKED on final runtime seed verification only -- all code, types, and static verifications pass)

## What was done

### Task 1: Auth.js v5 split config (Edge-safe base + full Node config) -- Complete
Read `prisma/schema.prisma` and `src/lib/db.ts` first and confirmed `User.hashedPassword: String?`, `User.role: Role`, `User.email: String @unique` all exist exactly as required -- no stop-gate triggered.

Ran `npm install next-auth@beta @auth/prisma-adapter`, resolving `next-auth@5.0.0-beta.32` and `@auth/prisma-adapter@2.11.3`. Confirmed `NextAuthConfig` is exported from `next-auth`'s type definitions (`node_modules/next-auth/index.d.ts`) exactly as the plan assumes, and `PrismaAdapter(prisma: PrismaClient | ...): Adapter` matches the expected shape -- no stop-gate triggered.

Created `types/next-auth.d.ts` augmenting `Session["user"]` and `User` with `id: string` and `role: Role` (imported from `@prisma/client`).

Created `src/auth.config.ts` -- Edge-safe base config: `pages.signIn = "/login"`, empty `providers: []`, and an `authorized({ auth }) { return !!auth?.user; }` callback. Contains zero references to `@auth/prisma-adapter`, `bcryptjs`, or `@/lib/db` (verified via grep, including in comments after one wording correction -- see Deviations).

Created `src/auth.ts` -- full Node config: spreads `authConfig`, adds `PrismaAdapter(db)`, `session: { strategy: "database" }`, and a `Credentials` provider. The `authorize()` function validates that `email`/`password` are non-empty strings before any database call, looks up the user by lowercased email, and returns `null` uniformly whenever the user does not exist, has no `hashedPassword` (e.g. a future OAuth-only account), or the bcrypt comparison fails -- never throwing and never distinguishing these cases in its return value. A `session` callback copies `user.id` and `user.role` onto the client session, merged with (not replacing) `authConfig`'s `authorized` callback. Exports `{ handlers, auth, signIn, signOut }`.

Created `src/app/api/auth/[...nextauth]/route.ts` exporting `GET`/`POST` destructured from `src/auth.ts`'s `handlers`.

### Task 2: Permission matrix and session helpers -- Complete
Created `src/lib/permissions.ts`: `Permission = "dashboard:view" | "admin:manage_users"`, `ROLE_PERMISSIONS: Record<Role, Permission[]>` giving all 5 roles `dashboard:view` and only `admin` also `admin:manage_users`, and `can(role, permission)` returning `ROLE_PERMISSIONS[role]?.includes(permission) ?? false` (fail-secure: an unrecognized role denies rather than throwing or defaulting to allow).

Created `src/lib/session.ts`: `getCurrentUser()` calls `auth()` from `@/auth` and returns `session?.user ?? null`; `requireRole(allowedRoles: Role[])` calls `getCurrentUser()` and redirects to `/unauthorized` (via `next/navigation`'s `redirect`) if the user is missing or their role isn't allow-listed.

### Task 3: Middleware and seed script -- Complete (code); seed runtime verification BLOCKED
Created `src/middleware.ts` importing only `NextAuth` from `"next-auth"` and `authConfig` from `"./auth.config"` -- confirmed via grep that it contains no `"@/auth"` reference anywhere, including comments. `export default NextAuth(authConfig).auth;` plus `export const config = { matcher: [...] }` excluding `login`, `api/auth`, static assets, and favicon.

Created `prisma/seed.ts`: instantiates its own `PrismaClient`, hashes the shared test password `"Password123!"` once via `bcryptjs`'s `hash(password, 10)`, then `upsert`s (keyed on `email`) exactly 5 users -- one per role -- with distinct `@mspdemo.local` emails. Idempotent by construction (re-running produces no duplicates). No plaintext password is ever logged; only the hash and emails are written to the database, and the completion log prints a count, not credentials.

Installed `tsx` as a dev dependency. Updated `package.json`'s `db:seed` script from its Plan 01-02 placeholder to `"prisma db seed"`, and added a `"prisma": { "seed": "tsx prisma/seed.ts" } ` field, per the plan's Task 3 instructions.

`npx tsc --noEmit` passes with exit 0 across the entire project, including all new auth/permissions/session/middleware/seed code.

`npx prisma migrate deploy` was run against a freshly started `docker compose up -d db` container and succeeded (applied the existing `20260831114041_init` migration cleanly to a new empty database).

**`npx prisma db seed` fails at runtime** -- see Blocker below. This is the one verification item that could not be completed.

## Blocker: Prisma 7.10.0 requires an explicit driver adapter at `PrismaClient` construction time

Running `npx prisma db seed` (after fixing Prisma 7's seed-command discovery -- see Deviations) fails with:

```
PrismaClientInitializationError: PrismaClient was instantiated without any options.
A driver adapter is required to connect to your database.
```

This is **not a defect in any file this plan controls**. It was root-caused by directly testing Plan 01-02's existing `src/lib/db.ts` pattern in isolation (`new PrismaClient()` with no arguments, exactly as `src/lib/db.ts` does) -- it fails identically, confirming this is a pre-existing latent defect in `src/lib/db.ts`, not something introduced by `prisma/seed.ts`. Plan 01-02 never actually instantiated a runtime `PrismaClient` (it only ran `migrate dev`, `generate`, and `validate`, none of which construct a client), so this defect was never previously exercised.

Root cause confirmed via direct testing:
- `prisma` and `@prisma/client` are both pinned to `7.10.0` (Plan 01-02's intentional stable pin) -- there is no newer stable 7.x patch to bump to; `7.10.0` is the latest published stable release.
- In Prisma 7 with the classic `prisma-client-js` generator, `new PrismaClient()` with zero constructor arguments unconditionally throws unless a driver adapter (e.g. `@prisma/adapter-pg`) is passed. The previously-available `datasourceUrl` constructor option has been removed (`Unknown property datasourceUrl provided to PrismaClient constructor`).
- `prisma7.config.ts`'s `PrismaConfig` type (`node_modules/prisma/config.d.ts`) has no `adapter` field -- that config only affects CLI commands (migrate/studio), not the generated `PrismaClient` runtime constructor used by application code. There is no zero-file-change fix available.

The correct fix is either (a) installing `@prisma/adapter-pg` and updating `src/lib/db.ts` to pass `new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })`, or (b) switching the `generator client` block in `prisma/schema.prisma` to Prisma 7's newer `prisma-client` generator with a different driver story. **Both remediation paths require editing files in this plan's `files_forbidden` list** (`src/lib/db.ts` is Plan 01-02's file; `prisma/schema.prisma` changes are explicitly stop-gated by this plan's own `<stop_gates>` section: "Do not change prisma/schema.prisma... emit BLOCKED rather than editing schema.prisma directly"). Installing `@prisma/adapter-pg` is also a new dependency not covered by this plan's `<execution_contract>` "Allowed tools/actions" (`npm install next-auth@beta @auth/prisma-adapter` only).

Per the harness's forbidden-file and stop-gate rules, this was not silently patched. **This blocks all runtime Prisma access, not just the seed script** -- it will also prevent `src/auth.ts`'s `PrismaAdapter(db)` and `getCurrentUser()` from working at runtime once the app actually runs, and will block every future phase's database access until fixed. This should be escalated and remediated (likely as a fast-follow fix to `src/lib/db.ts`, in a plan/scope authorized to touch it) before Plan 01-04 attempts real login testing.

**Everything else in this plan is unaffected**: all code is written correctly, type-checks cleanly, and follows the documented split-config/RBAC/security patterns. Once `src/lib/db.ts` is fixed to pass a driver adapter, `npx prisma db seed` is expected to succeed immediately with no changes needed to `prisma/seed.ts` itself.

## Seeded test users (for Plan 01-04, once the db.ts blocker above is resolved)

All 5 users share the same test password. **These are local-development-only credentials for the `@mspdemo.local` fake domain -- never use in any real deployment.**

| Role | Email | Password |
|---|---|---|
| technician | technician@mspdemo.local | `Password123!` |
| dispatcher | dispatcher@mspdemo.local | `Password123!` |
| sales | sales@mspdemo.local | `Password123!` |
| finance | finance@mspdemo.local | `Password123!` |
| admin | admin@mspdemo.local | `Password123!` |

Run `npx prisma db seed` (or `npm run db:seed`) after `src/lib/db.ts`'s driver-adapter issue is fixed and the `db` container is running (`docker compose up -d db`) to create these users.

## Files created/modified

- `types/next-auth.d.ts` (created) -- Session/User module augmentation
- `src/auth.config.ts` (created) -- Edge-safe base config
- `src/auth.ts` (created) -- full Node config with Credentials provider + Prisma adapter + database sessions
- `src/app/api/auth/[...nextauth]/route.ts` (created) -- NextAuth route handler
- `src/lib/permissions.ts` (created) -- `Permission` type, `ROLE_PERMISSIONS` matrix, `can()`
- `src/lib/session.ts` (created) -- `getCurrentUser()`, `requireRole()`
- `src/middleware.ts` (created) -- Edge-safe route protection
- `prisma/seed.ts` (created) -- idempotent 5-role seed script
- `package.json` (modified, additive) -- `db:seed` script updated from placeholder, `prisma.seed` field added, `tsx` devDependency added
- `package-lock.json` (modified, npm-managed)
- `prisma7.config.ts` (modified -- see Deviations) -- added `migrations.seed` field

## Verification commands run

| Command | Result |
|---|---|
| `test -f src/auth.config.ts && grep -q 'authorized' src/auth.config.ts` | PASS |
| `! grep -q 'PrismaAdapter\|bcryptjs\|lib/db' src/auth.config.ts` | PASS (after removing literal strings from a comment -- see Deviations) |
| `test -f src/auth.ts && grep -q 'PrismaAdapter' src/auth.ts` | PASS |
| `grep -q '"database"' src/auth.ts` | PASS |
| `test -f "src/app/api/auth/[...nextauth]/route.ts"` | PASS |
| `grep -q 'export function can' src/lib/permissions.ts` | PASS |
| `grep -q 'export async function getCurrentUser' src/lib/session.ts` | PASS |
| `grep -q 'export async function requireRole' src/lib/session.ts` | PASS |
| `test -f src/middleware.ts && grep -q 'auth.config' src/middleware.ts` | PASS |
| `! grep -q '"@/auth"' src/middleware.ts` | PASS (after removing literal string from a comment -- see Deviations) |
| `test -f prisma/seed.ts && grep -q 'technician' prisma/seed.ts && grep -q 'hash(' prisma/seed.ts` | PASS |
| `npx tsc --noEmit` | PASS (exit 0) |
| `docker compose up -d db` | PASS (container started, healthy) |
| `npx prisma migrate deploy` | PASS (applied existing migration to fresh db) |
| `npx prisma db seed` | **FAIL** -- `PrismaClientInitializationError: ... driver adapter is required` (see Blocker) |

## Decisions made

1. **Reworded two doxygen-style comments** in `src/auth.config.ts` and `src/middleware.ts` that originally explained the split-config rationale using the literal forbidden strings (`"PrismaAdapter"`, `"bcryptjs"`, `"@/auth"`) inside prose -- these were caught by the plan's own automated `grep`-based verification (which cannot distinguish code from comments). Reworded to preserve the exact same explanatory intent without the literal substrings, so the mandated verification commands genuinely pass rather than being bypassed.
2. **Added `migrations.seed: "tsx prisma/seed.ts"` to `prisma7.config.ts`** (already a required companion config generated by Plan 01-02, not a new file) after discovering Prisma 7.10.0 no longer reads the seed command from `package.json`'s `prisma.seed` field -- it now reads it from `prisma7.config.ts`'s `migrations.seed` property instead (`npx prisma db seed` printed "No seed command configured" pointing at this exact fix). Kept the `package.json` `prisma.seed` field too (harmless, forward/backward compatible) since the plan's Task 3 explicitly instructs adding it. This follows the same precedent Plan 01-02 set when the installed Prisma 7 CLI's actual behavior diverged from the plan's literal assumption.
3. **Did not touch `src/lib/db.ts` or `prisma/schema.prisma`** to fix the driver-adapter runtime error, even though doing so would have let the seed script run successfully, because both are explicitly `files_forbidden` for this plan and the fix (adding `@prisma/adapter-pg`) is also outside the plan's sanctioned `npm install` scope. Escalating instead, per the harness's blocking protocol.
4. Kept `db compose up -d db` running after verification (non-destructive, matches the state Plan 01-04 will need anyway).

## Security Review Notes (Security Engineer lens)

- **Error-message parity**: `src/auth.ts`'s `authorize()` returns `null` identically for (a) malformed/missing credentials, (b) no user with that email, (c) a user with no `hashedPassword` set (e.g. a future OAuth-only account), and (d) a wrong password. No code path throws a distinguishing error or returns different data shapes for these cases, so Auth.js's client-facing error surface cannot be used to enumerate valid account emails.
- **Input validation at the boundary**: `authorize()` explicitly checks `typeof email === "string"` and `typeof password === "string"` with non-zero length before ever querying the database, rejecting malformed input (e.g. arrays, objects, or empty strings that some Credentials-provider misuse patterns can pass) fail-closed.
- **Password hashing**: bcrypt (`bcryptjs`) is used throughout -- `compare()` in `src/auth.ts` for login verification, `hash(password, 10)` in `prisma/seed.ts` for seeding. Cost factor 10 is a reasonable default. No custom/rolled hashing logic anywhere.
- **Secrets handling**: No plaintext password is stored, logged, or returned anywhere. `prisma/seed.ts`'s `console.log` on success prints only a count; its `console.error` on failure prints the caught error object (a Prisma client error, never user credentials). The shared seed password `"Password123!"` is a hardcoded literal, but it is explicitly and only a local-development seed credential for a fake `@mspdemo.local` domain -- consistent with the plan's explicit instruction to use a known shared test password for exactly this purpose; it is not a production secret and is not read from or written to `.env`. `DATABASE_URL` continues to be sourced from `.env`/`prisma7.config.ts` as established in Plan 01-02 -- no new secrets were introduced or hardcoded.
- **Fail-secure defaults**: `can()` in `src/lib/permissions.ts` uses `?? false` so an unrecognized role denies rather than defaulting to allow. `requireRole()` in `src/lib/session.ts` redirects to `/unauthorized` on any missing user or disallowed role rather than falling through. Middleware's `authorized` callback returns `false` (redirecting to `/login`) whenever there is no session, rather than allowing by default.
- **Defense in depth**: Middleware (Edge, coarse cookie-presence check) and `requireRole()` (Node, authoritative role check) are intentionally two separate, independently-enforced layers, exactly as the split-config architecture requires -- middleware is documented in-code as NOT being the authorization boundary for roles.
- **No secrets committed**: Confirmed no new `.env`-like file was created or modified by this plan; `.env`/`.env.example` are unchanged from Plan 01-02. `git status --short` shows no unexpected files.
- **Finding surfaced (not a vulnerability, but a reliability/availability risk)**: the Prisma 7 driver-adapter runtime defect in `src/lib/db.ts` (see Blocker section) is not a security hole -- it fails closed (the app cannot connect to the database at all, rather than connecting insecurely) -- but it is a correctness/reliability defect that must be fixed before any phase depending on database access can function. Flagging for prompt remediation outside this plan's scope.

## files_forbidden -- confirmed untouched

Verified via `git status --short` and targeted `git diff --stat` checks: `src/app/(auth)/`, `src/app/(dashboard)/`, and `src/components/nav/` do not exist anywhere in the repo tree (confirmed via direct `ls` -- "No such file or directory" for all three). `git diff --stat -- docker-compose.yml` and `git diff --stat -- prisma/schema.prisma` both returned empty (no changes). `git diff --stat -- src/lib/db.ts` returned empty (not modified, despite being the root cause of the seed blocker -- left untouched per scope rules).

## Every planned task -- status

- Task 1 (Auth.js split config): **Complete**, all verifications pass.
- Task 2 (permission matrix + session helpers): **Complete**, all verifications pass.
- Task 3 (middleware + seed script): **Complete for all code/type verifications**; **BLOCKED** on the one runtime verification (`npx prisma db seed` actually creating 5 users), due to a pre-existing defect in a forbidden file (`src/lib/db.ts`) outside this plan's authority to fix. No planned work was self-deferred -- this is an explicit, evidenced escalation, not a skipped task.

## Resolution (coordinator, post-execution)

The user authorized fixing the Prisma driver-adapter defect directly rather than downgrading Prisma. The coordinator (outside this plan's own file scope, but with explicit user authorization) made the following changes:

1. Ran `npm install @prisma/adapter-pg pg` and `npm install -D @types/pg`.
2. Updated `src/lib/db.ts` (Plan 01-02's file) to construct a `PrismaPg` adapter from `DATABASE_URL` and pass it to `new PrismaClient({ adapter })`, per Prisma's own documented remediation for this exact error.
3. Updated `prisma/seed.ts` (this plan's file) identically, since it also instantiates its own standalone `PrismaClient()` rather than importing the shared `db` singleton, and hit the same error independently.
4. Ran `npx prisma generate` to confirm no preview feature flag was needed in `prisma/schema.prisma`'s generator block (none was — the classic `prisma-client-js` generator picks up the adapter purely from the constructor call).
5. Verified via a standalone Node script that `PrismaClient({ adapter })` connects and queries successfully.
6. Re-ran `npx prisma db seed` — succeeded, creating all 5 test users. Independently verified via a direct database query that all 5 users exist with correct emails and roles.
7. Re-ran the full Plan 01-03 verification suite (all 6 distinct checks, including `npx tsc --noEmit`) — all pass.

Noted but not addressed: `npm audit` flagges 3 high-severity transitive vulnerabilities in Prisma's own build-time `@prisma/config` → `deepmerge-ts` dependency chain (a stack-exhaustion DoS in a dev-time config parser, not reachable at runtime by external input). Fixing requires downgrading to `prisma@6.12.0`, which would reintroduce the API differences Plan 01-02 deliberately avoided by pinning to stable 7.x. Left as-is; worth revisiting when Prisma publishes a patched 7.x release.

Plan 01-03 is now genuinely Complete. Seeded credentials (table above) are confirmed working end-to-end and ready for Plan 01-04's login testing.
