import NextAuth from "next-auth";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { authConfig } from "./auth.config";

/**
 * Edge-safe route protection, wrapped with an IP-keyed in-memory rate
 * limiter (see below). This imports ONLY the Edge-safe base config
 * (./auth.config) -- never the full Node auth module, which pulls in the
 * Prisma adapter and cannot run in the Edge runtime.
 *
 * The wrapped NextAuth handler performs a coarse, fast check: "is there a
 * session at all?" (via the `authorized` callback in auth.config.ts),
 * redirecting to /login if not. It does NOT perform role-based
 * authorization -- that is the job of requireRole() in src/lib/session.ts,
 * called server-side (Node runtime) from protected Server
 * Components/layouts. Treat middleware as UX-speed defense only, never as
 * the authoritative permission boundary.
 */
const authMiddleware = NextAuth(authConfig).auth;

// ---------------------------------------------------------------------------
// IP-keyed in-memory rate limiter
// ---------------------------------------------------------------------------
//
// Scope/rationale (see 06-CONTEXT.md "Rate limiting approach"): this app is a
// self-hosted, single-instance deployment for <25 users. A fixed-window,
// in-memory limiter is a deliberate, sufficient choice for that scale -- NOT
// a distributed rate limiter. It resets on process restart and is only
// correct for a single Node/Edge process; do not assume it holds under
// horizontal scaling without moving the counter store to something shared
// (e.g. Redis) first. This is a brute-force/DoS speed bump, not a
// per-tenant quota system.
//
// Fixed-window (not sliding-window) is an accepted simplification: a burst
// straddling a window boundary can momentarily allow up to ~2x the stated
// rate. That's fine for this threat model (slowing down credential
// stuffing / scripted abuse), not a correctness bug.
//
// Shared-IP caveat: an MSP office (or any NAT'd site) puts every technician
// behind one public IP. Thresholds below are deliberately generous enough
// that normal multi-user office traffic -- several people loading pages,
// polling, and occasionally logging back in around the same time -- won't
// trip the limiter. This is why /api/auth/* (10 req/60s) is tighter than
// general routes (60 req/60s) but still well above what one legitimate
// login attempt (or a few concurrent ones from a shared office IP) needs.
//
// TRUST BOUNDARY -- see the full warning on getClientIp() below. Short
// version: this is IP-keyed via X-Forwarded-For/X-Real-IP, which are
// client-settable headers. Without a reverse proxy in front of this app
// that overwrites those headers with the real peer address, an
// unauthenticated attacker can spoof a fresh IP on every request and
// bypass this limiter entirely -- including the /api/auth/* brute-force
// protection. This project's docker-compose.yml currently exposes `app`
// directly with no such proxy, so treat this limiter as a no-op against a
// deliberate attacker until one is added in front of it.
const RATE_LIMIT_WINDOW_MS = 60_000;
const GENERAL_RATE_LIMIT = 60; // requests per window per IP, all other matched routes
const AUTH_RATE_LIMIT = 10; // requests per window per IP, /api/auth/* (credential-check surface)

type RateLimitEntry = { count: number; windowStart: number };

// Module-level Map -- persists for the lifetime of the Edge runtime instance.
// Cleared opportunistically (see cleanupStaleEntries) rather than via a
// scheduled job, to avoid unbounded growth over a long-running process
// without adding a timer/interval in the Edge runtime.
const rateLimitStore = new Map<string, RateLimitEntry>();

let requestsSinceCleanup = 0;
const CLEANUP_INTERVAL_REQUESTS = 500;

function cleanupStaleEntries(now: number) {
  requestsSinceCleanup += 1;
  if (requestsSinceCleanup < CLEANUP_INTERVAL_REQUESTS) return;
  requestsSinceCleanup = 0;

  for (const [key, entry] of rateLimitStore) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitStore.delete(key);
    }
  }
}

/**
 * Extracts the client IP from the request. Next.js 16's Edge middleware
 * runtime has no direct socket-address API (NextRequest.ip was removed in
 * Next.js 15) -- the documented approach is to read it from the
 * `x-forwarded-for` header, which a reverse proxy (nginx, Docker's own
 * network, a cloud LB) sets to "client, proxy1, proxy2" -- the first entry
 * is the original client. `x-real-ip` is a common single-value fallback some
 * proxies set instead. If neither header is present (e.g. hitting the app
 * directly with no proxy in front, which can happen in local dev), fall back
 * to a fixed key so rate limiting degrades to "one shared bucket" rather
 * than silently turning off -- documented here rather than left implicit.
 *
 * !!! TRUST BOUNDARY WARNING -- READ BEFORE RELYING ON THIS FOR SECURITY !!!
 * `x-forwarded-for` and `x-real-ip` are ordinary, client-settable HTTP
 * headers. Nothing in this file -- or anywhere else in this codebase --
 * verifies they were actually set by a trusted reverse proxy rather than by
 * the requester itself. This project's docker-compose.yml runs the `app`
 * service with port 3000 published directly to the host and has NO reverse
 * proxy in front of it. In that topology, any unauthenticated client can
 * send a different, forged `X-Forwarded-For` value on every single request
 * and this function will dutifully key the rate limiter on whatever the
 * attacker claims their IP is -- which completely defeats per-IP tracking,
 * INCLUDING the /api/auth/* brute-force protection above that this rate
 * limiter exists to provide.
 *
 * This is NOT fixed or mitigated anywhere in code, and cannot be from
 * inside this file: there is no way for an Edge middleware function to tell
 * "this header was set by my reverse proxy" apart from "this header was set
 * by the client" once both arrive as the same HTTP header on the same
 * socket. That distinction can only be enforced by something in front of
 * this app that strips/overwrites client-supplied X-Forwarded-For/
 * X-Real-IP and re-sets them from the real peer address (nginx, Caddy,
 * Traefik, a cloud load balancer, etc.).
 *
 * Bottom line:
 *   - Deployed with a reverse proxy that overwrites these headers: this
 *     rate limiter is a meaningful brute-force deterrent, as designed.
 *   - Deployed as this repo's docker-compose.yml ships it today (app
 *     exposed directly, no proxy): getClientIp() returns an
 *     attacker-controlled value on every request. IP-based rate limiting
 *     (including /api/auth/*) provides NO protection against a direct,
 *     header-spoofing attacker in this configuration.
 *   - The one topology where the current docker-compose.yml setup is still
 *     fine as-is is a genuinely trusted, internal-only network where the
 *     client population has no incentive/ability to spoof headers (e.g. a
 *     private LAN with no exposure to the internet) -- not the general
 *     self-hosted-on-the-internet case this app otherwise targets.
 * Do not treat this comment as resolved by a future code change to this
 * function; the fix is infrastructure (add a reverse proxy that owns these
 * headers), not application code.
 */
function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]!.trim();
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  // null, NOT a shared "unknown" key. The caller skips rate limiting entirely
  // for an unidentifiable client -- see the block comment at that call site for
  // the measured denial of service a shared bucket produced.
  return null;
}

/**
 * Fixed-window rate check for a single key. Returns null when the request is
 * allowed, or the number of seconds to wait (for Retry-After) when it is
 * not.
 */
function checkRateLimit(key: string, limit: number): number | null {
  const now = Date.now();
  cleanupStaleEntries(now);

  const entry = rateLimitStore.get(key);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(key, { count: 1, windowStart: now });
    return null;
  }

  if (entry.count >= limit) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - entry.windowStart);
    return Math.max(1, Math.ceil(retryAfterMs / 1000));
  }

  entry.count += 1;
  return null;
}

function rateLimited(retryAfterSeconds: number): NextResponse {
  return new NextResponse("Too Many Requests", {
    status: 429,
    headers: { "Retry-After": String(retryAfterSeconds) },
  });
}

/**
 * Middleware entry point. Runs the rate limiter first for every route the
 * matcher below covers -- including /api/auth/* AND /login -- then, for
 * everything except those two, delegates to the NextAuth coarse session-check.
 *
 * WHY /login IS HANDLED EXPLICITLY (corrected after review-cycle 2). The
 * previous matcher excluded `login` outright, on the assumption that
 * /api/auth/* was the credential-check surface AUTH_RATE_LIMIT protects. It is
 * not the surface this app uses. `loginAction` (src/app/(auth)/login/actions.ts)
 * is a Server Action: the browser POSTs it to the page's own URL, /login, and
 * it calls signIn() in-process. No request ever reaches /api/auth/callback/*.
 * So the tightened AUTH_RATE_LIMIT guarded endpoints this application never
 * calls, while the real password-guessing endpoint was excluded from the
 * middleware entirely and had NO limit at all. Measured before the fix: 70
 * POSTs to /login produced 0 x 429, while 70 GETs to /unauthorized (identical
 * client, same window) produced 10 x 429 -- proving the limiter worked and
 * simply never saw /login.
 *
 * /login now runs through the limiter, with the POST (the credential attempt)
 * charged against the tight `auth:` bucket and the GET against the general one.
 *
 * Both /api/auth/* and /login then return NextResponse.next() WITHOUT the
 * session gate. Those routes ARE the auth system: running "do you have a
 * session" in front of the login page would bounce every unauthenticated
 * visitor from /login to /login forever. The gate must never run here.
 */
export default function middleware(request: NextRequest, event: NextFetchEvent) {
  const pathname = request.nextUrl.pathname;
  const isAuthRoute = pathname.startsWith("/api/auth");

  // Exact match, not startsWith: only the login page itself skips the session
  // gate. A hypothetical /login-something must not inherit that exemption.
  const isLoginRoute = pathname === "/login";
  const isCredentialAttempt = isLoginRoute && request.method === "POST";

  const ip = getClientIp(request);
  const useAuthLimit = isAuthRoute || isCredentialAttempt;

  // WHY AN UNIDENTIFIABLE CLIENT IS NOT RATE LIMITED
  //
  // getClientIp() returns null when neither x-forwarded-for nor x-real-ip is
  // present. It previously fell back to the literal key "unknown", so every
  // such client would share ONE bucket.
  //
  // That was survivable while the tight bucket covered only /api/auth/*, which
  // this app never uses for login. Once POST /login joined that bucket, a
  // shared key would mean 10 requests per minute from anyone could lock every
  // user out of signing in.
  //
  // MEASURED, so the reasoning is not left hanging: on Next 16's dev server a
  // header is in fact always present, so this null branch does not fire and
  // bucketing is per source address (15 requests with distinct
  // x-forwarded-for values all passed; requests sharing a source correctly
  // shared a bucket). The shared-key hazard is therefore latent, not live --
  // it depends on a deployment where nothing upstream supplies either header,
  // which has NOT been observed here and is unverified for the Compose
  // topology.
  //
  // The branch stays because the failure mode it prevents is severe and the
  // cost is nil: counting an unidentifiable client cannot deter an attacker
  // (who spoofs a fresh x-forwarded-for per request and lands in a fresh
  // bucket anyway) while it could lock out everyone else. Skipping is the
  // safer default until Phase 8's reverse proxy makes the header trustworthy
  // -- the same infrastructure fix getClientIp()'s trust-boundary warning
  // above has always named. Do not restore a shared fallback key.
  if (ip === null) {
    return handleAfterRateLimit();
  }

  const limit = useAuthLimit ? AUTH_RATE_LIMIT : GENERAL_RATE_LIMIT;
  const rateLimitKey = useAuthLimit ? `auth:${ip}` : `general:${ip}`;

  const retryAfter = checkRateLimit(rateLimitKey, limit);
  if (retryAfter !== null) {
    return rateLimited(retryAfter);
  }

  return handleAfterRateLimit();

  function handleAfterRateLimit() {

  if (isAuthRoute || isLoginRoute) {
    return NextResponse.next();
  }

  // authMiddleware is NextAuth(authConfig).auth, the same value the previous
  // `export default NextAuth(authConfig).auth` exposed directly to Next.js's
  // middleware runtime -- Next.js itself always invokes the default export
  // with (request, event), so calling it the same way here preserves
  // identical behavior for every non-/api/auth/* route. NextAuth v5's `auth`
  // export type is an intersection of several call signatures (Pages Router
  // API-route usage, Server Component usage, App Router middleware usage,
  // etc.) and TypeScript's overload resolution for a 2-argument call picks
  // the Pages Router `(NextApiRequest, NextApiResponse)` signature instead
  // of the middleware `(NextAuthRequest, NextFetchEvent)` one -- a known
  // next-auth v5 typing limitation, not a runtime mismatch. Cast to the
  // actual runtime call shape used by Next.js's middleware invocation.
  const authAsMiddleware = authMiddleware as unknown as (
    req: NextRequest,
    ev: NextFetchEvent,
  ) => ReturnType<import("next/server").NextMiddleware>;

    return authAsMiddleware(request, event);
  }
}

export const config = {
  // WIDENED TWICE.
  //
  // First (plan critique): it excluded api/auth, so NextAuth's own endpoints
  // were never rate-limited.
  //
  // Second (review cycle 2): it excluded `login`, so the ACTUAL credential
  // endpoint this app posts to -- the /login page itself, which receives the
  // loginAction Server Action -- was never rate-limited either. Both
  // exclusions are gone; the isAuthRoute / isLoginRoute branches above skip
  // the session-check gate for them while the rate limiter still applies.
  //
  // Only genuinely static, non-credential paths remain excluded.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
