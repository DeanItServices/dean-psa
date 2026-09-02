# Phase 7 Context — Account Management & Session Freshness

## Goal

Let an admin onboard and offboard real MSP staff from the UI, with deactivations and role
changes taking effect immediately rather than up to 8 hours later.

## Why this phase exists

Phase 6's deployment work (06-09) surfaced that **there is no signup or
admin-account-creation UI anywhere in the app**. The only path to a real account today is a
`prisma/seed.ts` run with `ALLOW_SEED_IN_PRODUCTION=true`, or a direct database insert.
`DEPLOYMENT.md` documents this honestly rather than inventing a flow that does not exist.
That is a pre-launch blocker for handing this system to the MSP's team.

## Source documents

- `.planning/explorations/2026-09-02-launch-readiness-design.md` — **read first.** Carries
  the chosen approach, the three rejected alternatives, and verified line references.
- `.planning/CODEBASE.md` and `.planning/codebase/` — codebase map, fresh at commit
  `f2e1113` (fingerprint verified matching at plan time).

## Decisions locked before planning

| Decision | Outcome |
|---|---|
| Architecture proposals | **Skipped by user choice** — the exploration already compared four approaches and recorded the rejections. |
| Spec pipeline | **Skipped by user choice** — the design doc plus a fresh map gave decision-complete inputs. |
| Session freshness mechanism | **Database fresh-check inside `getCurrentUser()`**, not database sessions. Auth.js v5 hard-rejects `session.strategy: "database"` with a Credentials-only provider list (`src/auth.ts:7-14`) — a library constraint, not a preference. |
| Deactivation semantics | Deactivation is **not** deletion. Rows stay; `isActive` flips. Tickets, comments and time entries carry billing history. |
| Peer admins | Any admin may reset, demote or deactivate any **other** admin. Accepted: admins are mutually trusted and the audit log is deferred. Mitigated by structured non-secret logging in 07-03. |

## Existing assets this phase builds on

- **`admin:manage_users` already exists** (`src/lib/permissions.ts:10`), granted to `admin`
  only, and already gates a sidebar entry.
- **`getCurrentUser()` is the single choke point** (`src/lib/session.ts:14`, 34 lines).
  `requireRole()` delegates entirely to it. 25 importers.
- **`src/app/(auth)/layout.tsx` performs no session check** — a plain centered-card wrapper.
  A route placed in that group sits outside the `(dashboard)` gate by construction.
- **Server Action convention** (`src/lib/actions/companies.ts`): `requireRole` first, zod
  parse second, Prisma write third, `revalidatePath()` last. Errors return `{ error }`.

## Findings that shaped these plans

**From reading source at plan time:**

1. **`authorize()` has no active-user check** (`src/auth.ts:50-75`). Gating only
   `getCurrentUser()` leaves a bypass — a deactivated user logs in again and mints a fresh
   8-hour JWT. Closed in 07-02.
2. **`prisma/seed.ts:44` upserts with `update: {}`** — a re-seed will not set the new
   columns on existing accounts, so the E2E fixture would break once the gate is live.
   Closed in 07-01.

**From the plan critique (pre-mortem + assumption hunting), which returned REWORK:**

3. **CRITICAL — the `User` type augmentation would have broken Wave 1.** `authorize` is
   typed `=> Awaitable<User | null>` (`@auth/core/providers/credentials.d.ts:65`) and
   `src/auth.ts:69-74` returns `{id, email, name, role}`. Under `strict: true`, adding
   *required* fields to `User` fails TS2739 — and 07-01 may not edit `src/auth.ts`. Now
   optional on `User`, required only on `Session["user"]`, absent from `JWT`.
4. **CRITICAL — `mustChangePassword` was only a rendering gate.** `requireRole()` passes
   for such users, so all 10 action modules and `/api/qbo/connect` stayed callable by
   someone holding an intercepted temp password. 07-02 now enforces it in `requireRole()`.
5. **CRITICAL — wave ordering created a 404 trap.** 07-03 (Wave 2) sets the flag; the route
   that clears it was in Wave 3. A user created after Wave 2 shipped would loop on a 404
   with no admin remedy. `/change-password` is now 07-04, in Wave 2.
6. **CRITICAL — migration must precede app restart.** `authorize()` does `findUnique` with
   no `select`, so Prisma requests every column. Application code landing first raises P2022
   on every request and `loginAction` reports "Invalid email or password" to everyone,
   including every admin. Documented in 07-01 and 07-06's runbook task.
7. **CRITICAL — a bare `db.$transaction` does not serialize the last-active-admin count.**
   Prisma defaults to READ COMMITTED; two admins deactivating each other both see one
   remaining and both commit. 07-03 now requires a named mechanism.
8. **The sidebar has no Admin section.** `app-sidebar.tsx:74-98` is a single `<li>` with a
   ternary rendering one link labelled "Admin" → `/admin/quickbooks`, plus a dead
   else-branch. 07-05 restructures it rather than appending a link.
9. **`admin/quickbooks/page.tsx` does not use `requireRole`** — it uses `getCurrentUser()` +
   `can()` + manual redirects (`:50-58`). It is the layout model, not the gating model.
10. **No dialog primitive exists.** `src/components/ui/` has 12 files, none a dialog.
    `radix-ui` already exports `AlertDialog`; 07-05 imports it directly.
11. **`resetUserPassword` could strand the last admin.** Now refuses a self-target, and
    07-06 adds an explicit `--reset-password` break-glass.
12. **Zero automated tests.** Added as 07-07, along with the wave-close integration gate
    that no plan owned.
13. **`e2e/fixtures.ts` was unowned** and its post-login wait accepts `/change-password`.
    Now owned by 07-02.
14. **No `node_modules` in a fresh worktree** — every verification command would fail.
    `user_setup` now says so.

## Risk areas touched

- `src/lib/session.ts` — 25 importers; a regression logs out the whole application.
- `src/auth.ts` — the authentication boundary. `authorize()` returns an identical `null` on
  every failure path so account emails cannot be enumerated; that must survive.
- `types/next-auth.d.ts` — the augmentation constrains `authorize()`'s return literal.

## Plan structure

**7 plans across 4 waves.**

| Plan | Wave | Depends on | Agents |
|------|------|-----------|--------|
| 07-01 Schema, session types, seed | 1 | — | engineering-backend-architect |
| 07-02 Session freshness | 2 | 07-01 | engineering-security-engineer, testing-qa-verification-specialist |
| 07-03 User lifecycle actions | 2 | 07-01 | engineering-backend-architect, engineering-security-engineer |
| 07-04 Change-password route | 2 | 07-01 | engineering-frontend-developer |
| 07-05 Admin users UI | 3 | 07-02, 07-03 | engineering-frontend-developer |
| 07-06 Bootstrap and runbook | 3 | 07-01, 07-04 | engineering-backend-architect, infrastructure-devops-engineer |
| 07-07 Integration gate and E2E | 4 | all | testing-qa-verification-specialist, engineering-frontend-developer |

Wave 2's three plans and Wave 3's two have disjoint write targets. Wave 4 exists because no
plan otherwise owned the merged tree.

## Success criteria (from ROADMAP.md)

- [ ] Additive migration adds `User.isActive` and `User.mustChangePassword`; `prisma/seed.ts` sets both explicitly so the E2E login fixture keeps working
- [ ] `/admin/users` exists, gated on admin-only authorization and linked from the sidebar's Admin section, supporting create / edit-role / reset-password / deactivate / reactivate
- [ ] New-user creation lowercase-normalizes email to match `authorize()`, and shows the generated temp password exactly once without logging it
- [ ] `getCurrentUser()` performs one indexed lookup and returns database `role` / `isActive` / `mustChangePassword`; an inactive or deleted user resolves to null and is treated as unauthenticated
- [ ] Guard rails hold: an admin cannot deactivate or demote themselves, and at least one active admin always remains
- [ ] `/change-password` lives at `(auth)/change-password` and clears `mustChangePassword` on success
- [ ] `npm run bootstrap:admin` creates the first real admin, retiring `ALLOW_SEED_IN_PRODUCTION` as the documented path

## Accepted, with the decision recorded

- **Peer-admin actions are unrestricted and unaudited** beyond structured logging.
- **Session `maxAge` stays a decision for 07-02** — its 8-hour rationale ("no server-side
  mechanism to revoke a token early") becomes false in this phase and must be revisited
  explicitly, even if the number does not change.
- **A deactivated user is not told why** — the anti-enumeration property is deliberate.
  07-06 documents that deactivation must be communicated out-of-band.
- **Onboarding over plaintext HTTP** — Phase 8 delivers Caddy/TLS. 07-06's runbook states
  onboarding must wait for it, and leaves a Phase 8 marker.

## Explicitly NOT in scope

Admin audit log; email invites; self-serve password reset; SSO/OIDC; MFA; anything in
Phase 8 (proxy migration, Caddy, credentials) or Phase 9 (E2E run, ticket delete, QBO item
picker).
