# Project State

## Current Position
- **Phase**: 1 of 6 (executed, pending review)
- **Status**: Phase 1 complete — all 4 plans executed successfully
- **Last Activity**: Phase 1 execution (2026-08-31)

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
- **Session strategy changed from database to JWT** during Plan 01-04 execution: Auth.js v5 unconditionally rejects database sessions combined with a Credentials-only provider. Instant server-side session revocation is not currently available — flag for future phases if that becomes a real requirement (would need a token-blocklist table)
- Node.js upgraded system-wide from v20.0.0 to v24.19.0 LTS (Next.js 16 requires >=20.9.0)
- Prisma pinned to stable 7.10.0 (npm's `latest` tag resolved to an 8.0.0-rc pre-release); requires an explicit `@prisma/adapter-pg` driver adapter passed to every `PrismaClient` instantiation (a new Prisma 7 requirement discovered mid-phase)
- Seeded local dev test users: technician/dispatcher/sales/finance/admin @mspdemo.local, all password `Password123!` (local dev only, never for production)

## Next Action
Run `/legion:review` to verify Phase 1: Foundation & Platform Setup
