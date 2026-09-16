import NextAuth from "next-auth";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { authConfig } from "./auth.config";

/**
 * Route protection, wrapped with an IP-keyed in-memory rate limiter (see
 * below).
 *
 * RUNTIME: this file is the Next.js 16 Proxy convention (formerly
 * `middleware.ts`, deprecated in 16.0.0). Proxy runs on the Node.js runtime
 * and that runtime is NOT configurable -- setting a `runtime` config option
 * in a Proxy file throws. See
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:255.
 * Nothing here may therefore be justified by an Edge-runtime restriction;
 * where such a justification used to appear it has been corrected in place.
 *
 * It still imports ONLY the base config (./auth.config) and never the full
 * Node auth module. That is now a deliberate design choice rather than a
 * runtime requirement: the request-gate has no business pulling in the
 * Prisma adapter, a database connection, or password hashing just to answer
 * "is there a session?".
 *
 * The wrapped NextAuth handler performs a coarse, fast check: "is there a
 * session at all?" (via the `authorized` callback in auth.config.ts),
 * redirecting to /login if not. It does NOT perform role-based
 * authorization -- that is the job of requireRole() in src/lib/session.ts,
 * called server-side from protected Server Components/layouts. Treat this
 * proxy as UX-speed defense only, never as the authoritative permission
 * boundary.
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
// correct for a single Node.js server process; do not assume it holds under
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
// behind one public IP. The default thresholds below (operator-tunable
// since 08-02 -- see the env block) are deliberately generous enough
// that normal multi-user office traffic -- several people loading pages,
// polling, and occasionally logging back in around the same time -- won't
// trip the limiter. This is why /api/auth/* (10 req/60s) is tighter than
// general routes (60 req/60s) but still well above what one legitimate
// login attempt (or a few concurrent ones from a shared office IP) needs.
//
// TRUST BOUNDARY -- see the full note on getClientIp() below. Short
// version: this is IP-keyed via X-Forwarded-For/X-Real-IP, which are
// client-settable headers, so the limiter only means anything when
// something in front of this app owns that header. Since Phase 8 something
// does: `app` publishes no host ports, Caddy is the only ingress, and the
// Caddyfile sets `header_up X-Forwarded-For {remote_host}`, which replaces
// whatever arrived with Caddy's own observation of the peer. Before that,
// docker-compose.yml published `app` on 3000 with no proxy in front of it
// and this limiter was a no-op against anyone willing to forge a fresh IP
// per request.
//
// FOUR conditions carry that guarantee, and each is a way to lose it. They
// are enumerated ONCE, on getClientIp() below, and deliberately not
// restated here: this short form previously claimed there were "two",
// naming only Caddy-as-sole-ingress and Docker source-address fidelity. It
// silently dropped the `header_up X-Forwarded-For {remote_host}` line --
// which is precisely the condition `caddy validate` invites an operator to
// delete ("Unnecessary header_up X-Forwarded-For") -- and predated the
// fronting-proxy condition entirely. A reader who trusted the short list
// would have deleted a load-bearing line believing it was covered. Read
// the list on getClientIp() before changing anything in front of this app.

// OPERATOR-TUNABLE, READ FROM THE ENVIRONMENT AT PROCESS START.
//
// The three constants below are resolved ONCE, at module load -- i.e. when the
// Node.js server process starts -- and never re-read per request. Retuning one
// therefore costs a container restart, not a rebuild.
//
// This is only *genuinely* runtime-read because of the runtime move. Proxy runs
// on the Node.js runtime, and that is not configurable
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:255;
// .../01-app/02-guides/upgrading/version-16.md:616 -- "The `edge` runtime is
// **NOT** supported in `proxy`"). Under the previous Edge middleware
// convention the bundler inlined `process.env.X` at build time, so an
// "env-configurable" limit would have been illusory: frozen at `next build`
// and beyond the reach of whoever deploys it.
//
// An invalid value falls back; it never disables the control. envInt() accepts
// positive integers only -- non-numeric, empty, zero, negative and fractional
// input all keep the default below and log. `0` is rejected deliberately: this
// is a security control, and a typo must not be able to mean "limit disabled"
// (or, depending on comparison order, "nothing allowed"). Nothing here throws,
// either: this module runs on every matched request, so a throw at module load
// would be an app-wide outage caused by one mistyped variable.

/**
 * Reads a positive integer from `process.env`, falling back to `fallback` for
 * anything it cannot accept. Module-private on purpose -- these are
 * proxy-local tuning knobs, not a general configuration facility.
 *
 * The digits-only test runs BEFORE `Number.parseInt`, because `parseInt` is
 * lenient in exactly the directions that hurt here: it reads "1.5" as 1 and
 * "60abc" as 60, quietly applying a limit nobody wrote. A value that is not
 * wholly digits is rejected rather than salvaged.
 *
 * Unset is silent (that is the documented default path). Anything else that is
 * rejected warns once, at module scope, naming the variable, the offending
 * value and the default applied -- an operator who set the variable and sees
 * default behaviour must not be left guessing whether it took effect.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = raw.trim();
  const parsed = /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.warn(
      `[proxy] ${name}=${JSON.stringify(raw)} is not a positive integer; ` +
        `falling back to ${fallback}. The rate limit stays at its default -- ` +
        `it is NOT disabled.`,
    );
    return fallback;
  }

  return parsed;
}

// AUTH_URL shape check, run once at process start.
//
// docker-compose.yml guards AUTH_URL with `${AUTH_URL:?}`, but Compose can only
// check PRESENCE -- `http://psa.example.com` satisfies it. Auth.js then decides
// the `__Secure-` cookie prefix from `url.protocol === "https:"` alone
// (@auth/core init.js; see the COOKIE NAME note in src/lib/session.ts), so an
// http:// value behind a TLS-terminating proxy silently issues a session cookie
// with no Secure attribute and nothing anywhere reports it. This is the one
// production misconfiguration in this file's blast radius that produces no
// error at all, so say it loudly on stderr where `docker compose logs app`
// shows it. Warn rather than throw: http:// is correct in local development,
// and refusing to boot the whole app over a cookie attribute would be a worse
// failure than the one being prevented.
function warnOnInsecureAuthUrl(): void {
  if (process.env.NODE_ENV !== "production") return;
  const raw = process.env.AUTH_URL;
  if (raw === undefined || raw.trim() === "") return; // compose's :? guard owns this case
  let protocol: string;
  try {
    protocol = new URL(raw.trim()).protocol;
  } catch {
    console.warn(
      `[proxy] AUTH_URL=${JSON.stringify(raw)} is not a parseable URL. ` +
        "Auth.js derives the __Secure- session-cookie prefix from its protocol, " +
        "so this deployment may issue a non-Secure session cookie.",
    );
    return;
  }
  if (protocol !== "https:") {
    console.warn(
      `[proxy] AUTH_URL=${JSON.stringify(raw)} is not https://. In production this ` +
        "makes Auth.js issue a session cookie WITHOUT the __Secure- prefix and without " +
        "the Secure attribute, so it travels over plain HTTP. Set AUTH_URL to the public " +
        "https:// URL and restart. Verify by checking the cookie name in devtools after " +
        "logging in: it must be __Secure-authjs.session-token.",
    );
  }
}

warnOnInsecureAuthUrl();

const RATE_LIMIT_WINDOW_MS = envInt("RATE_LIMIT_WINDOW_MS", 60_000);
const GENERAL_RATE_LIMIT = envInt("RATE_LIMIT_GENERAL", 60); // requests per window per IP, all other matched routes
const AUTH_RATE_LIMIT = envInt("RATE_LIMIT_AUTH", 10); // requests per window per IP, /api/auth/* (credential-check surface)

type RateLimitEntry = { count: number; windowStart: number };

// Module-level Map -- persists for the lifetime of the Node.js server
// process this Proxy runs in. Cleared opportunistically (see
// cleanupStaleEntries) rather than via a scheduled job, to avoid unbounded
// growth over a long-running process without adding a timer/interval.
//
// KNOWN DEVIATION FROM THE DOCS, INHERITED DELIBERATELY. proxy.md:19 says of
// Proxy: "Proxy is meant to be invoked separately of your render code and in
// optimized cases deployed to your CDN for fast redirect/rewrite handling,
// you should not attempt relying on shared modules or globals." This module
// -level Map is exactly such a global. It is accepted here because this app
// is a self-hosted, single-instance Compose deployment with no CDN and no
// horizontal scaling -- the same scope decision the block comment above
// records. The moment that stops being true (a second app replica, a CDN or
// edge deployment of the Proxy), the counter stops being a single shared
// counter and the limiter silently weakens by a factor of the replica count.
// The fix at that point is a shared store (e.g. Redis), NOT a bigger Map.
// Carried forward knowingly rather than discovered later.
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
 * Extracts the client IP from the request. NextRequest exposes no
 * socket-address API in Next.js 16 -- `NextRequest.ip` was removed in
 * Next.js 15 and the Proxy convention did not bring it back, so this holds
 * on the Node.js runtime too -- and the documented approach is to read it
 * from the
 * `x-forwarded-for` header, which a reverse proxy (nginx, Docker's own
 * network, a cloud LB) sets to "client, proxy1, proxy2" -- the first entry
 * is the original client. `x-real-ip` is a common single-value fallback some
 * proxies set instead. If neither header is present (e.g. hitting the app
 * directly with no proxy in front, which can happen in local dev), return
 * null rather than a shared key; the call site skips rate limiting for that
 * request, for the measured reason recorded there.
 *
 * TRUST BOUNDARY -- WHAT IT WAS, WHAT CLOSED IT, AND WHAT STILL CARRIES IT
 *
 * `x-forwarded-for` and `x-real-ip` are ordinary, client-settable HTTP
 * headers. Nothing in this file -- or anywhere else in this codebase --
 * can verify they were set by a trusted reverse proxy rather than by the
 * requester itself: once both arrive as the same header on the same socket,
 * no request handler can tell them apart. That is true on the Node.js
 * runtime this Proxy file runs on exactly as it was under the Edge
 * middleware convention it replaced -- a header is a header. The
 * distinction is only enforceable by something IN FRONT of this app that
 * overwrites the header from the real peer address. It is an
 * infrastructure property, and no change to this function can substitute
 * for it.
 *
 * THE EXPOSURE, and why this block used to say the limiter was worthless:
 * until Phase 8, docker-compose.yml published `app` on port 3000 directly
 * to the host with NO reverse proxy in front of it. In that topology an
 * unauthenticated client could send a different forged `X-Forwarded-For` on
 * every single request, land in a fresh bucket each time, and bypass per-IP
 * limiting entirely -- including the /api/auth/* and POST /login
 * brute-force protection this limiter exists to provide. Against a
 * deliberate attacker it was a no-op.
 *
 * WHAT CLOSED IT: Caddy now terminates TLS in front of the app. `app`
 * publishes no host ports at all, so the only route in from the network is
 * through Caddy, and the Caddyfile's reverse_proxy block carries
 *
 *     header_up X-Forwarded-For {remote_host}
 *
 * which REPLACES the header with Caddy's own observation of the peer
 * address. Position 0 -- the entry `split(",")[0]` below reads -- is
 * therefore never client-supplied, and the boundary is enforced by
 * configuration this repository ships.
 *
 * That directive is load-bearing rather than belt-and-braces. Caddy's
 * default, with no `trusted_proxies` covering the peer, is already to DROP
 * an incoming X-Forwarded-For -- verified on caddy:alpine 2.11.4 by forging
 * a chain through it. But the default is CONDITIONAL: add any
 * `trusted_proxies` range that covers the peer (`trusted_proxies
 * private_ranges` is the single most commonly pasted Caddy snippet) and
 * Caddy forwards the incoming chain instead, so a forged
 * `X-Forwarded-For: 1.2.3.4` arrives upstream as `1.2.3.4, <peer>` and
 * position 0 is the attacker's value again (caddyserver/caddy#6783).
 * `header_up` removes the condition, so the guarantee does not depend on
 * the Caddy version behind a floating `:alpine` tag, nor on nobody ever
 * adding that line. Also verified: with `trusted_proxies 0.0.0.0/0` AND
 * `header_up` set, upstream still saw only the peer address.
 *
 * ONE SHARP EDGE, MEASURED: as of the measurement below, the Caddyfile
 * overwrote X-Forwarded-For and ONLY X-Forwarded-For, so a forged
 * `X-Real-IP` passed straight through to this function (verified: forging
 * both through the shipped config, the upstream saw
 * `X-Forwarded-For: <peer>` but `X-Real-IP: 66.66.66.66`).
 *
 * CHECK THE CADDYFILE RATHER THAN THIS PARAGRAPH for whether that is still
 * true: if a `header_up X-Real-IP {remote_host}` line has since been added
 * alongside the X-Forwarded-For one, that second header is overwritten too
 * and the pass-through is closed at the proxy. If it has not, the finding
 * above stands as written. This function is correct EITHER WAY, and for the
 * same reason in both: the order below reads x-forwarded-for first, and
 * Caddy sets that header on every proxied request, so the x-real-ip branch
 * is unreachable in the shipped topology whatever the Caddyfile does with
 * X-Real-IP.
 *
 * What that reachability argument depends on is the ORDER, so treat it as
 * load-bearing: do not reorder these two checks, and do not "simplify" them
 * into a first-non-empty-of-either lookup. Either change hands the attacker
 * the key again on any deployment whose proxy does not also own X-Real-IP.
 *
 * FOUR CONDITIONS CARRY THE CLAIM. Each is a way to lose it. Conditions 1
 * and 2 are what keep a forged header out; conditions 3 and 4 are what keep
 * the value that survives from collapsing every client into one bucket:
 *
 *   1. Nothing BYPASSES Caddy -- it stays the only ingress. Re-publishing
 *      `app`'s 3000 to the host, or reaching it from another container on
 *      the Compose network, restores the original exposure verbatim for
 *      whoever can do it.
 *   2. The `header_up` line stays in the Caddyfile. `caddy validate` emits
 *      "Unnecessary header_up X-Forwarded-For" and invites its deletion;
 *      that lint is wrong here, for the `trusted_proxies` reason measured
 *      above.
 *   3. The Docker daemon preserves source addresses. `{remote_host}` is
 *      whichever peer Caddy accepted the connection from; with standard
 *      iptables DNAT that is the real client. If the daemon routes
 *      published ports through the userland `docker-proxy` instead, every
 *      request appears to come from the bridge gateway and the entire
 *      internet shares ONE bucket -- which does not merely weaken the
 *      limiter, it turns it into a lockout affecting staff and attacker
 *      alike. Worth checking after go-live: `docker compose logs caddy`
 *      should show varied `remote_ip` values, not one repeated gateway
 *      address.
 *   4. Nothing is placed IN FRONT OF Caddy. Condition 1 is about reaching
 *      the app without passing through Caddy; this one is the opposite
 *      topology and is just as easy to arrive at by accident -- putting
 *      Cloudflare, an edge nginx, a corporate WAF or any other proxy ahead
 *      of it. Then `{remote_host}` is that fronting proxy's address, the
 *      same value on every request, and `header_up` faithfully writes it
 *      over the real chain. DEMONSTRATED by chaining two Caddys: every
 *      real-client request arrived upstream as one identical address.
 *      This is NOT a forgery bypass -- a client-supplied X-Forwarded-For is
 *      still dropped, so nobody gains a fresh bucket per request -- it is
 *      condition 3's failure mode by a different route: one shared bucket
 *      for the whole internet, i.e. the severe lockout, with POST /login on
 *      the tight limit and staff locked out alongside the attacker.
 *      REMEDY, if something must front Caddy: `header_up X-Forwarded-For
 *      {remote_host}` is no longer the right directive, because the real
 *      client address now only exists in the chain the fronting proxy
 *      sends. Replace it with a `trusted_proxies <CIDR>` configuration
 *      naming exactly that proxy's addresses -- never `private_ranges` as a
 *      reflex, and never `0.0.0.0/0` -- and revisit the parsing below,
 *      since with a forwarded chain position 0 is client-supplied again and
 *      the correct entry is counted from the right-hand (trusted) end. Do
 *      not make that change on the assumption it is harmless: it is exactly
 *      the configuration measured above to hand position 0 back to the
 *      attacker when the trusted set is too wide.
 *
 * STILL TRUE, and closed by none of the above: `rateLimitStore` is a
 * per-process, in-memory Map. It resets on container restart and is correct
 * for exactly one Node.js process. This is a brute-force speed bump, not a
 * distributed limiter and not a quota system -- a second `app` replica
 * divides its effectiveness by the replica count, and the fix at that point
 * is a shared store (e.g. Redis), not a bigger Map.
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
 * Proxy entry point. Runs the rate limiter first for every route the
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
export default function proxy(request: NextRequest, event: NextFetchEvent) {
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
  // which has NOT been observed here and is less likely still in the shipped
  // Compose topology, where Caddy sets X-Forwarded-For on every proxied
  // request.
  //
  // The branch stays because the failure mode it prevents is severe and the
  // cost is nil: counting an unidentifiable client cannot deter an attacker
  // (who would spoof a fresh x-forwarded-for per request and land in a fresh
  // bucket anyway) while it could lock out everyone else. Phase 8's reverse
  // proxy has since landed and makes the header trustworthy in the shipped
  // topology -- the infrastructure fix getClientIp()'s trust-boundary note
  // above always named -- but this branch is what covers the request that
  // arrives without one anyway. Do not restore a shared fallback key.
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
  // request-gate runtime -- Next.js itself always invokes the default export
  // with (request, event), so calling it the same way here preserves
  // identical behavior for every non-/api/auth/* route.
  //
  // THE CAST IS STILL REQUIRED UNDER THE NODE RUNTIME -- RE-DERIVED, NOT
  // COPIED. next-auth 5.0.0-beta.32 types `auth` as an intersection of five
  // call signatures (node_modules/next-auth/index.d.ts:209-211):
  //
  //   (NextApiRequest, NextApiResponse)            => Promise<Session | null>
  //   ()                                           => Promise<Session | null>
  //   (GetServerSidePropsContext)                  => Promise<Session | null>
  //   ((NextAuthRequest, AppRouteHandlerFnContext) => ...) => AppRouteHandlerFn
  //   (NextAuthMiddleware)                         => NextMiddleware
  //
  // Exactly ONE of those accepts two arguments, and it is the Pages Router
  // `(NextApiRequest, NextApiResponse)` one. There is no
  // `(NextRequest, NextFetchEvent)` signature to resolve to at all -- the
  // last two overloads take a single *handler function* and return one. So
  // `authMiddleware(request, event)` type-checks against the Pages Router
  // signature and fails; verified in this tree by deleting the cast and
  // running `npx tsc --noEmit`, which reports:
  //   src/proxy.ts: error TS2345: Argument of type 'NextRequest' is not
  //   assignable to parameter of type 'NextApiRequest'.
  //
  // This is a next-auth v5 typing limitation about *which* Next.js entry
  // point is being described, not a runtime mismatch, so the Edge -> Node
  // move does not affect it. Cast to the actual runtime call shape Next.js
  // uses to invoke the Proxy default export. `NextProxy` is next/server's
  // Next.js 16 name for that shape; `NextMiddleware`, which this cast used
  // before, is the identical type but carries an @deprecated tag
  // (node_modules/next/dist/server/web/types.d.ts:51-63).
  const authAsMiddleware = authMiddleware as unknown as (
    req: NextRequest,
    ev: NextFetchEvent,
  ) => ReturnType<import("next/server").NextProxy>;

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
