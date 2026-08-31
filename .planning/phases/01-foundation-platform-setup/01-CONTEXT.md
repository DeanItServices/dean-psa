# Phase 1: Foundation & Platform Setup -- Context

## Phase Goal
Stand up the application skeleton, database, authentication, and role-based access control (RBAC) that every later module (CRM, ticketing, billing, reporting) depends on.

## Requirements Covered
- Role-based access control (technician / dispatcher / sales / finance / admin roles) -- from PROJECT.md Active Requirements.

No `.planning/REQUIREMENTS.md` exists yet (pre-milestone-requirements-doc project). This phase relies on PROJECT.md and ROADMAP.md as the requirement source of truth.

## What Already Exists (from prior phases)
Nothing. This is Phase 1 of a greenfield project -- no prior phases, no existing repository content beyond `.planning/`.

## Key Design Decisions

**Architecture approach: Pragmatic** (selected from 3 competing proposals -- Minimal, Clean Architecture, Pragmatic -- presented to the user during planning).

Rationale for selection: the Minimal proposal's ad-hoc `if/else` role checks risk scattering permission logic across the codebase as later phases (billing, CRM) add nuance. The Clean Architecture proposal's full `Permission`/`RolePermission` database tables and domain-module folder structure were judged premature for a <25-user team with a fixed set of 5 roles. Pragmatic keeps the same lightweight libraries as Minimal but centralizes authorization through a single `can(user, action, resource)` helper checked consistently in middleware and server code -- avoiding permission-check drift without paying Clean's schema/module-boundary cost. It also keeps the door open to migrate to DB-driven RBAC later if custom per-user permissions ever become a real requirement.

**Stack decisions locked in for this phase:**
- **Framework**: Next.js (App Router) + TypeScript
- **Styling**: Tailwind CSS + shadcn/ui component library
- **Auth**: Auth.js (NextAuth v5) with Credentials provider + Prisma adapter, bcrypt password hashing, **database sessions** (not JWT-only) -- chosen so admins can revoke sessions later (needed for staff offboarding)
- **ORM/migrations**: Prisma against PostgreSQL
- **RBAC model**: `Role` enum column on `User` (`technician | dispatcher | sales | finance | admin`) + a static in-code permission matrix in `src/lib/permissions.ts`, checked via a `can(user, action, resource)` helper used in both `src/middleware.ts` and server-side code paths (Server Components / Route Handlers / Server Actions) -- NOT a full `Permission`/`RolePermission` database schema
- **Deployment**: Docker Compose running both the Next.js app AND Postgres (not Postgres-only), so a fresh clone works via `docker compose up` and dev mirrors how it will eventually run in production
- **Directory structure**: Standard Next.js App Router conventions with light feature-folder grouping under `src/` (`app/`, `lib/`, `components/`) -- not a strict DDD/module-per-domain layout

**Why these wave assignments:**
The dependency chain is strictly linear: scaffolding/infra must exist before auth can be wired (auth needs the Prisma User model and a running database); auth/sessions must exist before the UI shell can render role-aware navigation. 01-01 (scaffolding) and 01-02 (Docker+DB+schema) are independently verifiable and owned by different specialties -- combining them would force one agent to make both frontend tooling and schema decisions in the same plan -- but 01-02 formally depends on 01-01 (see revision note below) because both write to package.json, so they occupy consecutive waves rather than running in parallel within the same wave.

**Revision note (post plan-critique)**: The initial decomposition marked 01-01 and 01-02 as fully parallel within Wave 1. A plan-critique pass flagged a real `package.json` write-race risk (01-02 appends backend dependencies to the same file 01-01 creates), plus three other HIGH findings: unverified `create-next-app` CLI flags, an unaddressed Tailwind v3/v4 version ambiguity, and -- most significantly -- Auth.js v5's database-session strategy being incompatible with Next.js Edge middleware (PrismaAdapter cannot run in the Edge runtime). All four were fixed in the plan files directly:
- 01-02's `depends_on` now explicitly includes `01-01`, converting the package.json race into a strict sequential dependency instead of relying on `sequential_files` alone to arbitrate true concurrency.
- 01-01 adds fallback handling for `create-next-app` flags that may not exist in the installed CLI version, and detects/records whichever Tailwind major version (v3 or v4) was actually scaffolded rather than assuming v3.
- 01-03 now implements Auth.js's documented split-config pattern: `src/auth.config.ts` (Edge-safe, no PrismaAdapter, used only by `src/middleware.ts`) and `src/auth.ts` (full config with PrismaAdapter + Credentials provider + database sessions, used everywhere else). Middleware performs only a coarse session-cookie-presence check; role-based authorization is enforced server-side via `requireRole()`, consistent with the "service-layer enforcement, not just UI/middleware hiding" principle from the original architecture proposal comparison.
- 01-04's ambiguous "use whichever pattern src/auth.ts documents" instruction was replaced with a concrete decision tree (prefer the Server Action form of `signIn`/`signOut` from `@/auth`, falling back to `next-auth/react` client hooks only if the installed `next-auth@beta` version's types are incompatible), plus a stop-gate for a missing `components.json` before Task 2 attempts to add more shadcn components.

All plan files explicitly note that this project's shell of record is Git Bash (Windows environment), since the original plans' POSIX verification commands (`test -f`, `grep -q`) require it and this was flagged as a CRITICAL finding during critique.

**Trade-offs accepted:**
- No dynamic/custom roles or per-resource fine-grained permissions in v1 -- acceptable because the 5 roles are fixed and known
- Permission-matrix correctness depends on every route/action consistently calling `can()` -- mitigated by centralizing the check in a shared `requireRole`/`can()` helper used in Server Components/Actions, with middleware providing only a coarse, Edge-safe first line of defense (unauthenticated-request redirect), not full authorization
- Auth.js v5 API is still stabilizing -- mitigated by pinning exact dependency versions rather than using `latest`, and by giving 01-04 a concrete fallback decision tree rather than an open-ended "figure it out" instruction

## Plan Structure
- **Plan 01-01 (Wave 1)**: Project Scaffolding & Tooling -- Next.js + TypeScript init, Tailwind + shadcn/ui setup, base project config
- **Plan 01-02 (Wave 2)**: Docker + Database + Prisma Schema -- Docker Compose (app + Postgres), Prisma init, base schema (User, Role enum, Session, Account models) (depends on 01-01 -- both write package.json, so this runs after 01-01 completes rather than in parallel)
- **Plan 01-03 (Wave 3)**: Auth + RBAC Core -- NextAuth config + Credentials provider, permissions matrix + `can()` helper, middleware route protection + seed script (depends on 01-01, 01-02)
- **Plan 01-04 (Wave 4)**: UI Shell & Role-Aware Navigation -- login page, authenticated dashboard layout/nav shell, role-aware menu rendering, unauthorized page (depends on 01-03)
