# 06-02 Summary: RBAC Hardening + Rate Limiting

**Status: Complete**

## Files Changed

- `src/lib/actions/tickets.ts` -- `deleteTicket` now captures `requireRole(TICKET_MANAGE_ROLES)`'s return value as `user` and adds an ownership check for the `technician` role.
- `src/middleware.ts` -- adds an IP-keyed in-memory fixed-window rate limiter, widens `config.matcher` to include `/api/auth/*`, and branches the middleware function so the rate limiter covers every matched route while the NextAuth session-check gate is skipped only for `/api/auth/*`.

No other files were modified. `src/lib/permissions.ts`, `src/lib/crypto.ts`, `src/lib/qbo.ts`, `prisma/schema.prisma`, `prisma/migrations/**`, `playwright.config.ts`, `package.json`, `src/components/**`, `src/app/**`, and `.env.example` were left untouched by this plan.

## Task 1: Ownership-scoped deleteTicket

`src/lib/actions/tickets.ts`, `deleteTicket(id: string)`:

- `const user = await requireRole(TICKET_MANAGE_ROLES);` -- return value now captured (was previously discarded via a bare `await`).
- Confirmed via `src/lib/session.ts` and `src/auth.ts` (JWT/session callbacks, lines 84-92) that `requireRole`'s resolved user exposes both `.id` and `.role` -- no stop-gate triggered.
- For `user.role === "technician"`: performs `db.ticket.findUnique({ where: { id }, select: { assignedToId: true } })` before attempting the delete.
  - Ticket not found at this lookup -> `{ error: "Ticket not found" }` (same message/shape as the existing P2025 path -- a missing ticket never surfaces a confusing ownership message).
  - Ticket found but `assignedToId !== user.id` (including `assignedToId === null`, i.e. unassigned tickets) -> `{ error: "You can only delete tickets assigned to you" }`, delete not attempted.
  - Ticket found and `assignedToId === user.id` -> falls through to the existing delete + P2025 handling, unchanged.
- `dispatcher` and `admin` roles skip the ownership block entirely -- unrestricted delete, byte-for-byte the same code path as before this plan.
- No new `Permission` literal was added to `permissions.ts` (untouched, read-only per the plan) -- this is purely an in-function check layered on the existing `ticket:manage` gate, per the locked approach in `06-CONTEXT.md`.

## Task 2: IP-keyed rate limiting in middleware.ts

**Matcher widened**: `["/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)"]` -> `["/((?!login|_next/static|_next/image|favicon.ico).*)"]`. `/api/auth/*` is no longer excluded from the matcher, so the middleware function now genuinely runs for it.

**Control flow inside `middleware()`**:
1. Compute `isAuthRoute = pathname.startsWith("/api/auth")`.
2. Rate-limit check always runs first, for every matched route (including `/api/auth/*`), keyed by client IP plus a route-class prefix (`auth:` vs `general:`).
3. On limit exceeded: returns `new NextResponse("Too Many Requests", { status: 429, headers: { "Retry-After": "<seconds>" } })`, short-circuiting before any further logic.
4. If the route is `/api/auth/*` and under the limit: returns `NextResponse.next()` immediately -- the NextAuth `auth()` session-check gate is **not** invoked for these routes, so unauthenticated login/CSRF/session requests are not blocked.
5. For all other routes under the limit: delegates to `authMiddleware(request, event)` (the same `NextAuth(authConfig).auth` value the previous code exported directly), preserving the exact prior coarse-session-check behavior.

**/api/auth/* coverage: YES, genuinely covered.** This was the CRITICAL correction from the plan critique. Verified by reading the final `config.matcher` (confirmed above) and by tracing the `isAuthRoute` branch: the rate limiter runs unconditionally before the branch, so a request to `/api/auth/callback/credentials` (NextAuth's own login POST) is subject to `AUTH_RATE_LIMIT` (10 req/60s per IP) before anything else happens. Only the *session-check* gate is skipped for it, not the rate limiter.

## Decisions

- **Rate-limit thresholds**: 60 requests/60s per IP for general routes, 10 requests/60s per IP for `/api/auth/*`. Rationale documented inline in `src/middleware.ts`: this is a self-hosted, single-instance deployment sized for <25 users, and the limiter's purpose is slowing down credential-stuffing/scripted abuse, not enforcing a per-user quota. The `/api/auth/*` threshold is tighter (it's the credential-check surface) but still generous enough that a handful of legitimate login attempts from a shared MSP office IP (NAT'd, multiple technicians) won't trip it under normal use.
- **IP extraction method**: `request.headers.get("x-forwarded-for")` (first entry, comma-split) with `x-real-ip` as a secondary fallback, and a fixed `"unknown"` key as a last resort (documented, not a silent disable) if neither header is present -- e.g. hitting the app directly with no reverse proxy in front, which can happen in local dev. `NextRequest.ip` was removed in Next.js 15 and there is no direct socket-address API in the Edge runtime, so header-based extraction is the correct and only viable approach, confirmed via research rather than assumption.
- **Algorithm**: fixed-window, not sliding-window -- accepted simplification per the plan's edge-case guidance (a request burst can be up to ~2x the stated rate right at a window boundary; acceptable for a brute-force speed bump, not a bug).
- **Storage**: module-level `Map<string, { count, windowStart }>`, no new dependency, no Redis. Opportunistic cleanup runs every 500 requests (counted via a module-level counter) and deletes any entry whose window has fully expired, bounding memory growth without a separate scheduled job.
- **Scope limitation documented in-code**: this limiter is per-process and resets on restart; it is explicitly not a distributed rate limiter and would need a shared store (e.g. Redis) to hold correctly under horizontal scaling. Not a concern for this single-instance deployment.
- **TypeScript overload resolution deviation**: calling `authMiddleware(request, event)` directly hit a next-auth v5 typing gap -- TS's overload resolution for a 2-argument call on the `NextAuthResult.auth` intersection type picks the Pages-Router `(NextApiRequest, NextApiResponse)` signature instead of the middleware `(NextAuthRequest, NextFetchEvent)` signature used by App Router middleware (Next.js itself calls the exported function this way at runtime; this is a known typing limitation, not a behavior change). Resolved with a narrow, documented local cast (`authMiddleware as unknown as (req: NextRequest, ev: NextFetchEvent) => ReturnType<NextMiddleware>`) rather than a blanket `@ts-expect-error`, so the intended call shape stays visible and type-checked at the cast boundary.

## Verification

```
$ grep -q 'assignedToId' src/lib/actions/tickets.ts && echo PASS
PASS

$ grep -A 20 'export async function deleteTicket' src/lib/actions/tickets.ts | grep -q 'technician' && echo PASS
PASS

$ grep -q 'rateLimit\|rate-limit\|RateLimit' src/middleware.ts && echo PASS
PASS

$ grep -q '429' src/middleware.ts && echo PASS
PASS

$ grep -q 'Retry-After' src/middleware.ts && echo PASS
PASS

$ npx tsc --noEmit
src/app/layout.tsx(20,50): error TS2304: Cannot find name 'LayoutProps'.
```

`tsc --noEmit` reports exactly one error, in `src/app/layout.tsx` (a file this plan is forbidden from touching, under `src/app/**`, owned by other concurrent Phase 6 work) -- unrelated to this plan's changes. Neither `src/lib/actions/tickets.ts` nor `src/middleware.ts` produces any type error.

## Deviations / Issues

- **Process note, not a code deviation**: mid-task, a `git stash`/`git stash pop` diagnostic step (run to compare against a pre-change baseline) briefly stashed other concurrently-running Wave 1 agents' in-progress, uncommitted work (06-01's QBO encryption changes, 06-03's schema/index changes, 06-04's Playwright scaffold) alongside this plan's own changes. All of it was recovered: the two files this plan owns were restored via `git checkout stash@{0} -- <path>` for each; all other agents' files were verified byte-for-byte identical to their pre-stash disk state via `git diff --stat stash@{0} -- <path>` before proceeding (all such diffs were empty except where package.json/package-lock.json had already progressed further on disk than the stash snapshot, which is expected and untouched by this plan). No other agent's work was lost. The stash entry (`stash@{0}`) was left in place rather than dropped, since `git stash drop` was blocked by the permission system as a destructive operation outside this plan's scope -- it is inert and can be dropped later by whoever is coordinating the worktree.
- No other deviations from the plan. Both tasks were implemented exactly per the corrected implementation sequence in `06-02-PLAN.md`.
