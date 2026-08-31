# Project State

## Current Position
- **Phase**: 1 of 6 (complete)
- **Status**: Phase 1 complete — review passed in 2 cycle(s)
- **Last Activity**: Phase 1 review passed (2026-08-31)

## Progress
```
[####················] 21% — 4/19 plans complete
```

## Recent Decisions
- Tech stack: Next.js + TypeScript + PostgreSQL + Docker, self-hosted
- Execution mode: Guided
- Planning depth: Deep Analysis (6 phases)
- Cost profile: Balanced
- No data migration from ConnectWise/Autotask — starting fresh
- Client self-service portal explicitly deferred past v1
- Phase 1 architecture: Pragmatic approach (NextAuth/Auth.js v5 + Prisma + enum roles with centralized can() permission matrix, full Docker Compose) selected from 3 competing proposals
- Phase 1 plan critique (pre-mortem + assumption hunting) surfaced 1 CRITICAL and 3 HIGH findings; all fixed via plan revision before execution
- **Session strategy changed from database to JWT**: Auth.js v5 unconditionally rejects database sessions combined with a Credentials-only provider. Instant server-side session revocation is not currently available — flag for future phases if that becomes a real requirement (would need a token-blocklist table). JWT maxAge set to 8 hours to bound exposure.
- Node.js upgraded system-wide from v20.0.0 to v24.19.0 LTS (Next.js 16 requires >=20.9.0)
- Prisma pinned to stable 7.10.0 (npm's `latest` tag resolved to an 8.0.0-rc pre-release); requires an explicit `@prisma/adapter-pg` driver adapter passed to every `PrismaClient` instantiation
- Seeded local dev test users: technician/dispatcher/sales/finance/admin @mspdemo.local, all password `Password123!` (local dev only, never for production) — protected by a NODE_ENV=production guard in the seed script
- Phase 1 review: dynamic panel (QA verification specialist, security engineer, backend architect), 2 review cycles, 2 blockers + 6 warnings found and fixed (all in Docker/env-config completeness, not core auth logic). Deferred non-blocking suggestions: rename middleware.ts to proxy.ts (Next.js 16 convention), consolidate duplicated PrismaClient construction, add rate limiting before internet exposure.
- Post-review polish: skipped (user choice, session context constraints)

## Next Action
Run `/legion:plan 2` to plan Phase 2: CRM Core
