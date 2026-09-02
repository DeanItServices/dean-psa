# Design Exploration — Launch Readiness (v1 Go-Live)

*Created 2026-09-02. Repo state at time of writing: `547a50d` (synced with `origin/master`).*
*Revised 2026-09-02 (session 2) — resumed via `/legion:explore`. All six Open Questions from the first pass are now resolved; two new findings were promoted into MVP scope. Repo unchanged at `547a50d`.*

## Initial Ask

Derived from project context rather than a fresh idea. `.planning/ROADMAP.md` shows all 6 phases and 32/32 plans complete, but `.planning/STATE.md` closes with two gaps it calls out explicitly as "natural candidates for the very next work session":

1. No signup or admin-account-creation UI exists anywhere in the app — described as "a genuine pre-launch blocker for actually onboarding the MSP's real users."
2. None of the 3 Playwright E2E specs has ever executed against a real browser; `tsc --noEmit` proves type-correctness only.

The exploration scope is the gap between "v1 phases complete" and "real MSP users are working in this daily" — not new product surface.

**Session 2 scope:** resolve the six Open Questions the first pass deliberately left open, rather than re-opening the approach decision. The Recommended Approach below is unchanged and was not re-litigated.

## Research Summary

### Facts (verified by reading the code at `547a50d`, not from phase summaries)

**Account management**
- `admin:manage_users` already exists as a `Permission` (`src/lib/permissions.ts:10`) and is granted to `admin` only (`:57`).
- It is already the gate on the sidebar's Admin section (`src/components/nav/app-sidebar.tsx:74`), but the only link beneath it is `/admin/quickbooks` (`:78`). The seam for a users page exists and is unused.
- `src/app/(dashboard)/admin/` contains exactly one route: `quickbooks/page.tsx`.
- The only `db.user.create`-equivalent in the tree is `prisma/seed.ts`'s upsert loop. The seed throws under `NODE_ENV=production` unless `ALLOW_SEED_IN_PRODUCTION=true`, so today the only paths to a real admin account are a deliberately-overridden seed run or a direct DB insert.
- `User` (`prisma/schema.prisma`) has **no** `isActive` and **no** `mustChangePassword` field. `hashedPassword` is nullable.
- `Role` is a 5-value Postgres enum: `technician | dispatcher | sales | finance | admin`.

**Session model — the load-bearing constraint**
- `getCurrentUser()` (`src/lib/session.ts`) is `return (await auth())?.user ?? null` — it performs **zero database queries**. `requireRole()` delegates entirely to it.
- Sessions are self-contained JWTs, `maxAge` 8 hours, with no adapter-backed session store. `src/auth.ts` documents that Auth.js v5 hard-rejects `session.strategy: "database"` alongside a Credentials-only provider list, so database sessions are not available without a token-blocklist table.
- The JWT carries both `id` and `role` (jwt callback, `src/auth.ts`). **Consequence:** a role edit is as stale as a deactivation — both would be invisible for up to 8 hours.
- `authorize()` looks users up via `email.toLowerCase()`. Any create path must normalize identically or the account is unreachable.

**Deployment topology**
- `docker-compose.yml` publishes `app` as `3000:3000` with no proxy service — exactly the topology `src/middleware.ts` warns makes `getClientIp()` return an attacker-controlled value on every request.
- Rate-limit constants are hardcoded in `src/middleware.ts`: 60s window, 60 req general, 10 req on `/api/auth/*`.
- The middleware matcher excludes `login` but covers `/api/auth/*` — the real credential-check surface is in fact rate-limited.

**E2E**
- Playwright chromium **is already installed** (`~/.cache/ms-playwright/chromium-1234`), and `dean-psa-app-1` + `dean-psa-db-1` have been up for hours. The suite has not run because nobody ran it, not because a prerequisite is missing.
- `playwright.config.ts` uses `fullyParallel: true` and a `webServer` running `npm run dev` against **the local dev database** — no separate test-database strategy.

**Known debt confirmed still present**
- `deleteTicket` is defined at `src/lib/actions/tickets.ts:237` with zero call sites in `src/`; `e2e/tickets.spec.ts:231` documents the two `test.fixme` cases honestly.
- `src/lib/actions/invoices.ts:367` hardcodes `ItemRef: { value: "1", name: lineItem.description }`.

### Facts added in session 2

**`middleware.ts` is deprecated in Next.js 16 — renamed to `proxy.ts`, on the Node runtime**
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md` states the convention is **deprecated** in Next.js 16 and renamed to `proxy.js`. Codemod: `npx @next/codemod@canary middleware-to-proxy .`
- `.../03-file-conventions/proxy.md:255`: "Proxy defaults to using the Node.js runtime. The `runtime` config option is not available in Proxy files. Setting the `runtime` config option in Proxy will throw an error."
- `.../02-guides/upgrading/version-16.md:616`: "The `edge` runtime is **NOT** supported in `proxy`. The `proxy` runtime is `nodejs`, and it cannot be configured."
- The named export `middleware` is deprecated alongside the filename; the function should be renamed to `proxy`. Config flags rename too (`skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize`) — this project sets neither; `next.config.ts` is empty of options.
- **This settles the env-inlining Open Question.** Under `proxy.ts` the file executes in an ordinary Node process, so `process.env` is read at runtime. Env-configurable rate limits are genuine, not illusory — no rebuild, no build-arg fallback, no database-backed setting.
- `proxy.md:779` and `:22` still caution that Proxy "can run outside of your application's main runtime" and that you "should not attempt relying on shared modules or globals." The existing module-level `rateLimitStore` Map does rely on a global — this is unchanged from today's Edge behaviour and remains acceptable for a single-instance deployment, but it is now formally against documented guidance and should be noted rather than silently inherited.

**`/change-password` has a clean home — no new route group needed**
- `src/app/(auth)/layout.tsx` is a plain centered-card wrapper with **no** session check of any kind. The `mustChangePassword` gate belongs in `src/app/(dashboard)/layout.tsx`, which already calls `getCurrentUser()` and redirects to `/login` on null.
- So `(auth)/change-password` sits outside the redirecting gate by construction — the loop the first pass worried about cannot form.
- The matcher `/((?!login|_next/static|_next/image|favicon.ico).*)` still covers `/change-password`, so NextAuth's `authorized` callback (`!!auth?.user`, `src/auth.config.ts`) keeps the route authenticated-only. Exactly the desired semantics with no matcher edit.

**Ticket delete destroys billing records — undocumented in the action**
- `deleteTicket`'s docstring claims it "Cascades to the ticket's TicketComments (onDelete: Cascade in prisma/schema.prisma)". That is incomplete.
- `prisma/schema.prisma:265` also declares `TimeEntry.ticket` as `onDelete: Cascade`. Deleting a ticket therefore destroys **every time entry logged against it**.
- `TimeEntry.invoiceLineItem` is `onDelete: SetNull` (`:280`) — the *line item* survives. So an invoice would retain its total while losing the time records that justify it. Silent billing-history corruption, reachable from a UI that does not exist yet.
- This is why the delete decision below is narrower than "wire up a button".

**Postgres credentials appear in three places, not one**
- `postgres:postgres` is hardcoded inline in the `DATABASE_URL` of **both** the `app` and `email-poller` services, in addition to `POSTGRES_PASSWORD` on the `db` service. The credential change touches all three, plus `.env.example`.
- `db` publishes `${DB_PORT:-5432}:5432` to the host.

### Inferences

- The unused `admin:manage_users` permission plus its live sidebar gate means the users page is a low-friction addition — the authorization plumbing and the navigation slot both already exist.
- Because `getCurrentUser()` is the single choke point every protected layout and `requireRole()` call already funnels through, one change there propagates to the entire app uniformly. This is why the balanced approach is cheap relative to what it delivers.
- Caddy overwriting `X-Forwarded-For` converts the existing rate limiter from decorative to genuinely effective without touching the proxy/middleware file — the fix the code comment says can only come from infrastructure.
- Adding a `mustChangePassword` gate risks breaking all three existing E2E specs through the shared login fixture if seeded users acquire the flag. Seed must set it explicitly `false`.
- The `proxy.ts` migration and the env-configurable-rate-limit requirement are the same piece of work. Doing the rename *first* makes the rate-limit change trivially correct; doing it second means writing env handling against a deprecated Edge file and then re-verifying it after the move.
- `src/auth.config.ts`'s entire reason for existing is Edge-safety ("This file MUST remain runnable in the Next.js Edge runtime"). After the proxy migration that constraint is no longer technically binding. It should nonetheless be **left in place** — the split is still good design (the proxy has no business importing the Prisma adapter), and loosening it during a launch-readiness milestone buys nothing.

### Assumptions (unverified — flagged, not treated as known)

- That fewer than ~25 users makes one primary-key lookup per protected request negligible. Consistent with `.planning/PROJECT.md`'s stated sizing, but never load-tested.
- That QBO endpoint URLs and invoice payload shape are correct — `STATE.md` records these were never verified against Intuit's live documentation. Unchanged by this exploration; the item-picker work will exercise a *new* QBO endpoint (item list) and may surface the same class of problem.
- That bcryptjs cost factor 10 (as used in `prisma/seed.ts`) is acceptable for real accounts.
- That NextAuth v5's `auth` wrapper behaves identically when invoked from a Node-runtime `proxy.ts` as from Edge middleware. Expected — it is the same handler — but the existing overload-resolution cast in the file (`authAsMiddleware`) is a known-fragile spot and should be re-checked during the migration rather than copied blindly.
- *(Resolved, previously an assumption)* Public DNS and inbound port 80 — **confirmed available**, so Caddy's HTTP-01 challenge applies. No DNS-01 plugin, no provider API token.

## Product Definition

- **Target users:** MSP admins performing onboarding/offboarding, and every internal user who needs a real (non-seed) account to log in at all.
- **Primary outcome:** The MSP can onboard its real staff, offboard departures with immediate effect, and expose the app safely — without a shell on the server or a direct database edit.
- **Value proposition:** Converts a feature-complete-on-paper v1 into something that can actually be handed to the team on launch day.
- **Non-goals:** Client-facing portal, legacy PSA data migration, RMM auto-ticketing, project management module (all deferred past v1 in `PROJECT.md` and unchanged here). No SSO/OIDC. No multi-factor auth. No horizontal scaling.

## Recommended Approach

**Balanced — freshness enforced at the single existing choke point, behind Caddy.** *(Unchanged from session 1; not re-opened.)*

The whole design turns on one observation: `getCurrentUser()` is the only place session identity is resolved, and today it reads nothing but the JWT. Adding a single indexed `user.findUnique` there, and returning the database's `role` and `isActive` rather than the token's, simultaneously delivers:

- **Immediate deactivation** — an offboarded technician loses access on their next request, not up to 8 hours later.
- **Immediate role changes** — closing the stale-role bug that the "edit role" requirement would otherwise introduce.
- **The first-login password gate** — `mustChangePassword` is read from the same query, at no extra cost.

Three requirements, one ~15-line change, at a per-request cost of one primary-key lookup that is negligible at this project's stated scale. The alternative — accepting eight-hour staleness — means "deactivate" does not actually deactivate, which is difficult to defend for a system holding client data.

Caddy is paired with this because it is infrastructure, not application code, that fixes the `X-Forwarded-For` trust boundary. The rate-limiting file states this plainly and correctly refuses to pretend otherwise. Caddy overwrites the header by default and obtains TLS certificates automatically, so the rate limiter becomes real and the app stops being served over plaintext HTTP — with roughly five lines of configuration and the fewest ways to get it subtly wrong.

**Session 2 addition:** the deployment-hardening workstream now leads with the `middleware.ts` → `proxy.ts` migration. This was not a scope expansion for its own sake — it is the prerequisite that makes the env-configurable rate limits in the same workstream actually work, and it stops the launch milestone from building new configuration surface on a convention Next.js 16 has deprecated.

## Alternatives Considered

| Approach | Strengths | Tradeoffs | Decision |
|----------|-----------|-----------|----------|
| **Balanced — DB fresh-check in `getCurrentUser()`, Caddy proxy** | Deactivation and role edits take effect immediately; one change serves three requirements; uses the existing choke point and the already-wired `admin:manage_users` gate | Adds one DB query per protected request; `getCurrentUser()` becomes strictly Node-runtime (already true in practice) | **Chosen** |
| Minimal — accept 8h staleness | No schema-adjacent session work; smallest diff; no per-request query | Offboarded staff keep working up to 8h; demoted users keep old permissions just as long; the "deactivate" button would overpromise what it does | Rejected — the weakest claim to working offboarding, on a system holding client data |
| Ambitious — add admin audit log + Graph email invites | Records who created/deactivated/re-roled whom; nicer onboarding UX; reuses Microsoft Graph credentials already configured for the poller | Meaningfully more surface to build and verify pre-launch; invite-token lifecycle and mail-failure paths are their own design problem | Deferred to "Later" — audit log is the stronger half and should come first |
| Database sessions for real revocation | The textbook answer to JWT revocation | Auth.js v5 hard-rejects database sessions with a Credentials-only provider (documented in `src/auth.ts`); would require a bespoke token-blocklist table | Rejected — blocked by the library, and the DB fresh-check achieves the same practical outcome |

### Session 2 decisions

| Decision | Options weighed | Chosen | Rationale |
|----------|-----------------|--------|-----------|
| **Caddy TLS challenge** | HTTP-01 (public DNS + :80) · DNS-01 with provider plugin · serve existing internal-CA certs · defer | **HTTP-01** | Public DNS and inbound port 80 confirmed available. Stock `caddy:alpine` image, no custom build, no DNS-provider API token to store or rotate. The minimal-config path is also the one with the fewest ways to get subtly wrong. |
| **Deprecated `middleware.ts`** | Migrate to `proxy.ts` in MVP · defer migration, keep middleware · migrate but drop env-configurable limits | **Migrate in MVP** | The Node runtime is what makes env-read-at-runtime real, so the migration and the rate-limit requirement are one job. Deferring means writing new config surface against a deprecated Edge file and re-verifying after the eventual move. |
| **`deleteTicket` resolution** | Wire owner-scoped delete button · admin-only · remove the dead action entirely | **Admin-only** | Ticket deletion touches billing history (see below); restricting it to admins matches who is accountable for that data. Technicians close tickets, they don't delete them. |
| **TimeEntry cascade on delete** | Refuse if any time is invoiced · refuse if any time logged at all · schema migration to `onDelete: Restrict` · allow with a counting warning dialog | **Refuse when any time entry is invoiced** | Protects billing history at the point it actually matters, with no schema migration and no risk of a migration failing against existing rows. An admin who genuinely needs the ticket gone closes or archives it instead. |
| **QBO `ItemRef`** | Live item-list picker · manual item-ID text field · verify account first · defer | **Live item-list picker** | The QBO company has real Items defined, so the picker has something to show. A connection-level default chosen from the live list is self-validating in a way a typed ID is not. |
| **E2E database** | First real run against the dev DB, decide after · promote a separate test DB into MVP now | **First run on dev DB** | Buying the test-DB setup before any evidence risks solving a problem the run may not have. `fullyParallel: true` against a shared DB is a real hazard, but the failure signature will say so plainly, and the decision is cheap to revisit with evidence in hand. |

## Feature Scope

### MVP

**Account management**
- [ ] Migration adding `User.isActive` (default `true`) and `User.mustChangePassword` (default `false`)
- [ ] `/admin/users` list page, gated on `admin:manage_users`, linked from the existing sidebar Admin section
- [ ] Create user: email (lowercase-normalized to match `authorize()`), name, role, server-generated temp password shown exactly once and never logged
- [ ] Edit role and reset password on an existing user
- [ ] Deactivate / reactivate, taking effect on the user's next request
- [ ] Guard rail: an admin cannot deactivate or demote themselves, and the system must always retain at least one active admin
- [ ] `src/lib/actions/users.ts` server actions gated via an `ADMIN_MANAGE_ROLES` constant, following the existing `CRM_MANAGE_ROLES` pattern rather than inline role literals

**Session freshness**
- [ ] `getCurrentUser()` performs an indexed lookup and returns database `role` / `isActive` / `mustChangePassword`; an inactive or deleted user resolves to `null` (treated as unauthenticated)
- [ ] `/change-password` at `src/app/(auth)/change-password/` — inherits the session-check-free `(auth)` layout, so it sits outside the gate that redirects to it; the existing matcher already keeps it authenticated-only via the `authorized` callback
- [ ] Dashboard layout redirects to `/change-password` when `mustChangePassword` is set
- [ ] `prisma/seed.ts` sets `mustChangePassword: false` and `isActive: true` explicitly, so the E2E login fixture keeps working

**Bootstrap**
- [ ] `scripts/create-admin.ts` (`npm run bootstrap:admin`) creating the first real admin safely, retiring the `ALLOW_SEED_IN_PRODUCTION` workaround as the documented path

**Deployment hardening**
- [ ] **Migrate `src/middleware.ts` → `src/proxy.ts`** via `npx @next/codemod@canary middleware-to-proxy .`; rename the default export's function to `proxy`; re-verify the `authAsMiddleware` overload cast still type-checks under the Node runtime. Update the file's own comments — several assert Edge-runtime constraints that stop being true.
- [ ] Leave `src/auth.config.ts` split out as-is, but correct its docstring: the split is now a design choice, not an Edge-runtime requirement
- [ ] Rate-limit window and thresholds read from `process.env` with the current values (60s / 60 / 10) as defaults — genuinely runtime-read now that the file is Node-runtime
- [ ] Caddy service (stock `caddy:alpine`) in `docker-compose.yml` using **HTTP-01** automatic TLS; `app` no longer publishes 3000 to the host; Caddy owns 80/443 and overwrites `X-Forwarded-For`
- [ ] Remove the host-published `db` port; replace `postgres:postgres` with generated secrets sourced from `.env` in **all three** places (`db.POSTGRES_PASSWORD`, `app.DATABASE_URL`, `email-poller.DATABASE_URL`)
- [ ] `DEPLOYMENT.md` and `.env.example` updated; the `getClientIp()` trust-boundary warning revised to state the boundary is now actually enforced by Caddy

**Verification and debt**
- [ ] Run `npm run test:e2e` for real against the dev database and fix what breaks; record whether `fullyParallel: true` on a shared DB caused any of the failures
- [ ] Admin-only ticket delete: change `deleteTicket`'s technician-ownership branch to an admin gate, **and refuse the delete when any of the ticket's time entries has a non-null `invoiceLineItemId`** (returning a clear error naming the invoice). Wire a confirmation dialog on the ticket detail page. Rewrite the two `test.fixme` cases in `e2e/tickets.spec.ts` as admin/non-admin + invoiced-time cases.
- [ ] Correct `deleteTicket`'s docstring to name the `TimeEntry` cascade, not just `TicketComment`
- [ ] Replace the hardcoded QBO `ItemRef.value: "1"` with a connection-level default item chosen from a live QBO item list on `/admin/quickbooks`

### Later

- [ ] Admin audit log of user-lifecycle actions
- [ ] Email invites via the existing Microsoft Graph credentials
- [ ] Self-serve password reset (depends on outbound email)
- [ ] Per-service-item QBO mapping, beyond a single connection default
- [ ] Separate E2E test database — revisit immediately after the first real run, with its failure output as the evidence
- [ ] Automated backups and a restore drill for the Postgres volume
- [ ] Reconsider `TimeEntry.ticket` as `onDelete: Restrict` at the schema level, if the application-level refusal proves insufficient

## Experience / Workflow

**Onboarding a technician.** Admin opens Admin → Users, clicks New User, enters name and work email, picks `technician`. The app generates a temp password and displays it once, with a copy control and an explicit "this will not be shown again" warning. The admin hands it over out-of-band. On first login the technician is redirected to `/change-password` and cannot reach any dashboard route until they set a new password, which clears `mustChangePassword`.

**Offboarding.** Admin opens Admin → Users, finds the departing technician, clicks Deactivate, confirms. On that user's very next request `getCurrentUser()` resolves `null` and they are redirected to `/login`, where `authorize()` also refuses them. Their tickets, comments, and time entries remain intact — deactivation is not deletion, which matters because those rows carry billing history.

**Deleting a ticket (admin only).** An admin opens a ticket created in error — a spam email that became a ticket, a duplicate — and clicks Delete. If any time entry on that ticket has already been invoiced, the action refuses and names the invoice; the admin closes the ticket instead. Otherwise a confirmation dialog states what will be destroyed (comments and any uninvoiced time entries) and the delete proceeds, returning to the Kanban board. Technicians see no delete control at all.

**Bootstrapping a brand-new deployment.** Operator brings up the stack, runs migrations, then `npm run bootstrap:admin`, entering an email and password at the prompt. They log in over HTTPS through Caddy — which obtains its certificate automatically via HTTP-01 on first request — and create the rest of the team from the UI. No shell access is needed again.

## Technical Direction

- **Platform unchanged:** Next.js 16.3.3, React 19.2.8, Auth.js v5 beta, Prisma 7 with `@prisma/adapter-pg`, Postgres 16, Docker Compose, self-hosted.
- **Schema:** one additive migration, two boolean columns with defaults — no backfill required, no destructive change. Follows the existing `prisma/migrations/` timestamp convention. The `TimeEntry` cascade is handled in application code, not schema, so no second migration.
- **Session:** JWT strategy retained; the database becomes authoritative for `role` and `isActive` at read time. The JWT stays the authentication proof; the database becomes the authorization source. The 8-hour `maxAge` remains a reasonable outer bound.
- **Runtime boundary:** `getCurrentUser()` gaining a Prisma call formalizes what `src/lib/session.ts` already documents — it is Node-only. After the `proxy.ts` migration the proxy file *is* Node-runtime too, which removes the technical barrier; the architectural rule stands anyway. The proxy keeps its coarse cookie-presence check and knows nothing about `isActive`; the authoritative gate stays server-side.
- **Proxy file:** `src/proxy.ts`, Node runtime (not configurable). The module-level `rateLimitStore` Map continues to work for a single-instance deployment, but note that `proxy.md` explicitly advises against relying on globals in Proxy — acceptable here, worth a comment rather than silent inheritance.
- **Reverse proxy:** Caddy in front on 80/443, `app` reachable only on the internal Compose network. HTTP-01 automatic TLS. Caddy's default `X-Forwarded-For` handling is what makes `getClientIp()` trustworthy; no application code changes for this.
- **Secrets:** Postgres credentials move to `.env`, referenced from three service definitions. Note that `POSTGRES_PASSWORD` applies only at initdb — an existing volume needs `ALTER USER` inside the running container, then a `DATABASE_URL` update in both `app` and `email-poller`.
- **Testing:** the existing Playwright setup is used as-is for the first real run, against the dev database. New user-lifecycle specs must account for `fullyParallel: true` — deactivation specs in particular must not race the shared login fixture.

## Open Questions

*All six questions from session 1 are resolved. Recorded here with their resolutions for traceability, followed by the questions this session opened.*

**Resolved**
- ~~Caddy TLS challenge type~~ — **HTTP-01.** Public DNS and inbound port 80 confirmed available. Stock `caddy:alpine`, no DNS plugin.
- ~~Does Next.js 16 inline `process.env` into the Edge middleware bundle?~~ — **Moot.** `middleware.ts` is deprecated; `proxy.ts` runs on the Node runtime (not configurable), so env is read at runtime. Migration is in MVP scope.
- ~~Where does `/change-password` live without a redirect loop?~~ — **`src/app/(auth)/change-password/`.** The `(auth)` layout performs no session check, and the gate lives in `(dashboard)/layout.tsx`, so the loop cannot form. Existing matcher already keeps the route authenticated-only.
- ~~Does the MSP's QuickBooks company have real Items?~~ — **Yes.** Build the live item-list picker.
- ~~Should E2E get its own database now?~~ — **No.** First real run goes against the dev database; revisit with its output as evidence.
- ~~Is a delete button on tickets actually wanted?~~ — **Yes, admin-only**, and refused when any time entry on the ticket is already invoiced.

**Opened in session 2**
- **Does the `authAsMiddleware` overload cast in `src/middleware.ts:224` survive the move to `proxy.ts`?** The cast works around a known next-auth v5 typing limitation for the Edge middleware call signature. Under the Node runtime the invocation shape should be identical, but the cast is fragile enough to warrant explicit re-verification rather than a copy-paste. *Resolution: verify during the migration; `tsc --noEmit` will catch it.*
- **Does the codemod handle a default-export `middleware` function cleanly?** This file exports `export default function middleware(...)` plus a `config` object with a hand-written matcher and extensive comments. *Resolution: run the codemod, then diff and hand-correct; do not assume the comments survive meaningfully.*
- **What should happen to a ticket an admin cannot delete because its time is invoiced?** Refusing is decided; whether the UI should then offer "close" or "archive" as the next step is a UX detail. *Resolution: decide during planning — the refusal error message is the minimum, an inline action is the nicer version.*
- **Does the QBO item-list endpoint work against the live API?** The picker exercises a QBO endpoint the codebase has never called, and `STATE.md` already records that existing QBO endpoint URLs were never verified against Intuit's live documentation. *Resolution: verify the item-list query against the real company or a sandbox before building the picker UI on top of it.*

## Start Input

**Milestone: Launch Readiness (v1 Go-Live).** Close the gap between a feature-complete v1 and a system real MSP staff can be onboarded onto.

Four workstreams:

1. **Admin user management** — `/admin/users` with create, edit-role, reset-password, and deactivate, plus a `bootstrap:admin` script, hanging off the already-wired-but-unused `admin:manage_users` permission and sidebar gate.
2. **Session freshness** — one indexed lookup in `getCurrentUser()` making the database authoritative for `role` and `isActive`, which delivers immediate deactivation, immediate role changes, and a first-login forced password change together. `/change-password` lives at `(auth)/change-password`, outside the `(dashboard)` gate that redirects to it.
3. **Deployment hardening** — migrate the deprecated `middleware.ts` to `proxy.ts` (Node runtime, which is what makes env-configurable rate limits real), then a Caddy reverse proxy with HTTP-01 automatic TLS (which is what actually fixes the documented `X-Forwarded-For` spoofing gap), removal of default Postgres credentials from all three service definitions, and removal of the host-published database port.
4. **Verification and debt** — the first real `npm run test:e2e` execution against the dev database, an admin-only ticket delete that refuses when any time entry is already invoiced (closing an undocumented `TimeEntry` cascade that would corrupt billing history), and a real QBO item reference chosen from a live item list, replacing the hardcoded `"1"`.

Additive schema change only (`User.isActive`, `User.mustChangePassword`). One new container (Caddy); no new application dependencies. Deferred: audit log, email invites, self-serve password reset, per-item QBO mapping, separate E2E database, schema-level `Restrict` on the TimeEntry cascade.
