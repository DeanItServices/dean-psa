# Phase 7 Context — Account Management & Session Freshness

## Goal

Let an admin onboard and offboard real MSP staff from the UI, with deactivations and role
changes taking effect immediately rather than up to 8 hours later.

## Why this phase exists

Phase 6's deployment work (06-09) surfaced that **there is no signup or
admin-account-creation UI anywhere in the app**. The only path to a real (non-seed) account
today is a `prisma/seed.ts` run with `ALLOW_SEED_IN_PRODUCTION=true`, or a direct database
insert. `DEPLOYMENT.md` documents this honestly rather than inventing a flow that does not
exist. That is a genuine pre-launch blocker for handing this system to the MSP's team.

## Source documents

- `.planning/explorations/2026-09-02-launch-readiness-design.md` — **read this first.** It
  carries the chosen approach, the three rejected alternatives, and the verified line
  references behind every success criterion below.
- `.planning/CODEBASE.md` and `.planning/codebase/` — codebase map, fresh as of commit
  `f2e1113` (fingerprint verified matching at plan time).

## Decisions locked before planning

| Decision | Outcome |
|---|---|
| Architecture proposals | **Skipped by user choice.** The exploration already compared four approaches and recorded why three were rejected; regenerating proposals would re-litigate a settled decision. |
| Spec pipeline | **Skipped by user choice.** The design doc plus the fresh codebase map already give decision-complete inputs. |
| Session freshness mechanism | **Database fresh-check inside `getCurrentUser()`**, not database sessions. Auth.js v5 hard-rejects `session.strategy: "database"` with a Credentials-only provider list — this is documented in `src/auth.ts:7-14` and is a library constraint, not a preference. |
| Deactivation semantics | Deactivation is **not** deletion. Rows stay; `isActive` flips. Tickets, comments and time entries carry billing history and must survive offboarding. |

## Existing assets this phase builds on

- **`admin:manage_users` already exists** as a `Permission` (`src/lib/permissions.ts:10`),
  granted to `admin` only, and already gates the sidebar's Admin section
  (`src/components/nav/app-sidebar.tsx:74`). The authorization plumbing and the navigation
  slot both exist and are unused — only `/admin/quickbooks` hangs off it today.
- **`getCurrentUser()` is the single choke point** (`src/lib/session.ts:14`). `requireRole()`
  delegates entirely to it. It has 25 importers. One change there propagates uniformly.
- **`src/app/(auth)/layout.tsx` performs no session check** — it is a plain centered-card
  wrapper. A route placed in that group sits outside the `(dashboard)` gate by construction.
- **Server Action convention**: `requireRole(X_MANAGE_ROLES)` first, zod parse second,
  Prisma write third, then `revalidatePath()`. Errors return `{ error: string }` rather
  than throwing. See `src/lib/actions/companies.ts` for the canonical shape.

## Findings from plan-time code reading (not in the design doc)

Two things were discovered while reading source for this decomposition. Both change what
the plans must do:

1. **`authorize()` has no active-user check** (`src/auth.ts:50-75`). It returns on a
   successful password compare alone. Adding an `isActive` gate only to `getCurrentUser()`
   would leave a bypass: a deactivated user simply logs in again and mints a fresh 8-hour
   JWT. Both paths must be closed. This is Task 2 of plan 07-02.
2. **`prisma/seed.ts:42-51` upserts with `update: {}`**. Re-running the seed against an
   existing database will not set the new columns on accounts that already exist, so
   relying on column defaults is not sufficient for the E2E fixture accounts. The seed must
   write both fields in `create` *and* `update`. This is Task 3 of plan 07-01.

## Risk areas touched (from CODEBASE.md)

- `src/lib/session.ts` — highest blast radius in the phase (25 importers). Any regression
  here logs out the entire application.
- `src/auth.ts` — the authentication boundary. `authorize()` deliberately returns an
  identical `null` on every failure path so account emails cannot be enumerated; that
  property must survive the `isActive` change.
- `types/next-auth.d.ts` — module augmentation. Changing what `getCurrentUser()` returns
  starts here, or `tsc` will reject the new fields.

## Plan structure

**5 plans across 3 waves.** The two new columns gate everything, so they are Wave 1 alone.
Session freshness and the user-lifecycle actions touch disjoint files and run parallel in
Wave 2. Both UI surfaces depend on Wave 2 and land in Wave 3.

| Plan | Wave | Depends on | Agents |
|------|------|-----------|--------|
| 07-01 Schema, session types, and seed | 1 | — | engineering-backend-architect |
| 07-02 Session freshness | 2 | 07-01 | engineering-security-engineer, testing-qa-verification-specialist |
| 07-03 User lifecycle Server Actions | 2 | 07-01 | engineering-backend-architect, engineering-security-engineer |
| 07-04 Admin users UI | 3 | 07-03 | engineering-frontend-developer |
| 07-05 First-login and bootstrap | 3 | 07-01, 07-02 | engineering-frontend-developer, engineering-backend-architect |

## Success criteria (from ROADMAP.md)

- [ ] Additive migration adds `User.isActive` (default true) and `User.mustChangePassword` (default false); `prisma/seed.ts` sets both explicitly so the E2E login fixture keeps working
- [ ] `/admin/users` exists, gated on the already-wired `admin:manage_users` permission and linked from the sidebar's Admin section, supporting create / edit-role / reset-password / deactivate / reactivate
- [ ] New-user creation lowercase-normalizes email to match `authorize()`, and shows the generated temp password exactly once without logging it
- [ ] `getCurrentUser()` performs one indexed lookup and returns database `role` / `isActive` / `mustChangePassword`; an inactive or deleted user resolves to null and is treated as unauthenticated
- [ ] Guard rails hold: an admin cannot deactivate or demote themselves, and at least one active admin always remains
- [ ] `/change-password` lives at `(auth)/change-password` (outside the `(dashboard)` gate that redirects to it) and clears `mustChangePassword` on success
- [ ] `npm run bootstrap:admin` creates the first real admin, retiring `ALLOW_SEED_IN_PRODUCTION` as the documented path

## Explicitly NOT in scope

Deferred to the "Later" list in the design doc, or to Phases 8-9:

- Admin audit log of user-lifecycle actions
- Email invites via the existing Microsoft Graph credentials
- Self-serve password reset (depends on outbound email)
- SSO/OIDC, multi-factor auth
- Anything in Phase 8 (proxy migration, Caddy, credentials) or Phase 9 (E2E run, ticket
  delete, QBO item picker)
