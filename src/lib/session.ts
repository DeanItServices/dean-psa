import type { Role } from "@prisma/client";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getToken } from "next-auth/jwt";
import type { JWT } from "next-auth/jwt";
import { db } from "@/lib/db";

/**
 * Request-scoped lookup of the authoritative user row.
 *
 * Wrapped in React's cache() so that every getCurrentUser() call made while
 * rendering a single request shares one query. cache() is REQUEST-scoped: it
 * cannot span requests and therefore cannot introduce staleness -- it is a
 * per-request dedupe, not a TTL cache. Without it a single dashboard render
 * issues 2-3+ identical auth queries (layout + page + nested components), so
 * a brief database blip becomes an app-wide forced-logout storm.
 *
 * `select` is explicit and narrow: it never loads hashedPassword, and it
 * keeps the query to a primary-key index read.
 */
const findSessionUser = cache(async (id: string) => {
  return db.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      tokenVersion: true,
    },
  });
});

/**
 * The decryption secret list, assembled exactly the way @auth/core assembles
 * it from the environment (its setEnvDefaults pushes AUTH_SECRET, then
 * unshifts AUTH_SECRET_1..3): the rotation slots first, then the current
 * AUTH_SECRET, so a token minted under any live secret still decodes.
 * Reproduced rather than imported because @auth/core applies it to a config
 * object we have no handle on from here.
 *
 * Throws rather than returning an empty list. With no secret the token cannot
 * be decoded at all, which would resolve every caller to null and read as
 * "the whole application silently logged out" -- exactly the misdiagnosis the
 * fail-closed note below exists to prevent. Auth.js itself refuses to run in
 * this state, so this can only fire on a misconfigured deployment.
 */
function sessionSecrets(): string[] {
  const secrets = [
    process.env.AUTH_SECRET_3,
    process.env.AUTH_SECRET_2,
    process.env.AUTH_SECRET_1,
    process.env.AUTH_SECRET,
  ].filter((secret): secret is string => typeof secret === "string" && secret.length > 0);

  if (secrets.length === 0) {
    throw new Error(
      "AUTH_SECRET is not set, so the session cookie cannot be decoded. " +
        "Set it in the environment (see .env.example) and restart.",
    );
  }

  return secrets;
}

/**
 * Decodes THIS request's session JWT straight from the cookie.
 *
 * WHY NOT auth(). auth() returns the `Session` object produced by the session
 * callback in src/auth.ts -- and that same object is what NextAuth serves to
 * the browser from GET /api/auth/session. Anything this function needs that
 * had to be copied onto `Session` to be readable here would therefore also be
 * readable by any client, whether or not the app ever calls useSession(). The
 * revocation claim in particular must not be: it is a password-rotation
 * counter, and /api/auth/session is exempt from the middleware session gate
 * and never consults this module, so it would answer for a token this module
 * refuses. Reading the raw token keeps the claim server-side, and keeps `id`
 * and `tokenVersion` sourced from one place -- the same cookie, decoded once.
 *
 * COOKIE NAME. Auth.js names the session cookie `authjs.session-token`, or
 * `__Secure-authjs.session-token` when it decides the deployment is HTTPS
 * (@auth/core's init.js: `config.useSecureCookies ?? url.protocol ===
 * "https:"`, where the URL comes from AUTH_URL or the forwarded-proto
 * header). Rather than re-deriving that decision -- which would silently log
 * every user out if a library upgrade changed it -- both names are tried, in
 * that order. The two cannot be confused: the salt Auth.js encrypts with IS
 * the cookie name, so a token only decodes under the name it was stored as,
 * and a `__Secure-` cookie is never sent over plaintext HTTP at all. Secure
 * first, so a stale unprefixed cookie left over from an http deployment
 * cannot shadow the live one after TLS is turned on.
 *
 * Request-scoped via cache() for the same reason findSessionUser is: several
 * getCurrentUser() calls per render must not each pay for a JWE decrypt.
 */
const readSessionToken = cache(async (): Promise<JWT | null> => {
  const req = { headers: await headers() };
  const secret = sessionSecrets();

  return (
    (await getToken({ req, secret, secureCookie: true })) ??
    (await getToken({ req, secret, secureCookie: false }))
  );
});

/**
 * Returns the currently authenticated user, or null.
 *
 * The session is a self-contained signed JWT (no server-side session store --
 * the Prisma adapter is not used; see src/auth.ts). The JWT is therefore used
 * ONLY to identify the caller; the DATABASE is authoritative for `role`,
 * `isActive` and `mustChangePassword`. That makes deactivation and role
 * changes take effect on the next request instead of after the 8-hour
 * session maxAge, and gives the app a real revocation mechanism it previously
 * lacked.
 *
 * A user row that is missing (deleted) or has isActive=false resolves to
 * null, i.e. is treated as unauthenticated by every caller.
 *
 * PASSWORD-CHANGE REVOCATION (`tokenVersion`). Re-reading role/isActive/
 * mustChangePassword is NOT sufficient on its own, because none of those
 * change when a password is rotated. Without the check below, `resetUserPassword`
 * would have no effect whatsoever on an already-issued JWT: an attacker riding
 * a stolen session would survive the reset and could then walk to
 * /change-password and set a password of their own, converting a stolen
 * session into a permanent account takeover -- while the admin UI told the
 * victim the old password had stopped working.
 *
 * So every JWT carries the `tokenVersion` that was current when it was minted
 * (src/auth.ts's authorize + jwt callback), and every request compares it
 * against the live column. Any write that increments the column invalidates
 * every token issued before it. The claim is stamped ONCE, at sign-in, and is
 * never refreshed from the database -- that frozen-at-mint property is the
 * whole mechanism, so neither this function nor the jwt callback may re-read
 * it.
 *
 * The claim is read from the RAW TOKEN (readSessionToken above), never from
 * the `Session` object, and it is deliberately absent from the `Session` type
 * augmentation -- see readSessionToken's comment for why a claim on `Session`
 * is a claim on the wire.
 *
 * A token with NO tokenVersion claim -- one minted by a build that predates
 * this mechanism -- is refused, deliberately. It cannot be distinguished from
 * a token whose generation is unknown, so it is treated as revoked. The
 * one-time cost is that everyone signed in across the deploy of this change
 * has to log in again; the alternative (treating "absent" as "matches 0")
 * would leave exactly the pre-existing tokens this mechanism exists to revoke
 * silently accepted.
 *
 * FAIL CLOSED: if the lookup throws it is deliberately NOT caught. We never
 * fall back to the JWT's `role` claim -- that would restore the staleness bug
 * at exactly the moment the database cannot contradict it. Letting the throw
 * propagate is fail-closed (no user object is ever produced, so nothing
 * downstream grants access) and it is legible: a database outage, or a P2022
 * raised because the isActive/mustChangePassword/tokenVersion migration has
 * not been applied to this environment, surfaces as an error instead of
 * masquerading as every user being silently logged out. A cookie that is
 * absent, expired, or fails to decrypt is not an error but an
 * unauthenticated request: getToken() resolves it to null and the id check
 * below refuses it.
 *
 * This performs a Prisma query and reads the request headers, so this module
 * is strictly Node-runtime: use it from Server Components, Server Actions and
 * Route Handlers only -- never from Edge middleware.
 */
export async function getCurrentUser() {
  const token = await readSessionToken();
  const id = token?.id;

  // Reject anything that is not a usable id before touching the database.
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }

  const tokenVersion = token?.tokenVersion;

  const user = await findSessionUser(id);

  if (!user || !user.isActive) {
    return null;
  }

  // Revocation check. `!==` on a number, and a token that carries no claim at
  // all (typeof !== "number") is refused rather than defaulted -- see the
  // tokenVersion paragraph above.
  if (typeof tokenVersion !== "number" || tokenVersion !== user.tokenVersion) {
    return null;
  }

  return user;
}

/**
 * Session gate for a page that has NO role restriction of its own.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE (dashboard) LAYOUT. The layout performs
 * the same two redirects, but Next.js does not re-render a shared layout on a
 * soft (client-side) navigation between two routes in the same group. A user
 * whose `mustChangePassword` was set -- or who was deactivated -- while
 * already browsing therefore keeps navigating the whole dashboard, because
 * the only code that would have bounced them never runs again. The gate has
 * to live in the leaf that renders on every navigation.
 *
 * Use this wherever a page previously open-coded
 * `getCurrentUser()` + `if (!user) redirect("/login")`. Pages with a role or
 * permission requirement should use requireRole() (or keep their own `can()`
 * check AFTER this call, for the permission sets requireRole's role list
 * cannot express).
 *
 * Returns a non-null user, so the caller needs no null handling.
 */
export async function requireActiveUser() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  // Same flag, same target as requireRole(). A temp-password holder must not
  // be able to read dashboard data either, not just to invoke actions.
  if (user.mustChangePassword) {
    redirect("/change-password");
  }

  return user;
}

/**
 * Authoritative, server-side role gate. Fail-secure: any missing session or
 * role not in the allow-list redirects to /unauthorized rather than letting
 * the caller proceed. This is the real authorization boundary for role
 * checks -- middleware only verifies a session cookie is present, it does
 * not evaluate roles.
 *
 * It is also the boundary for `mustChangePassword`. Gating that flag only in
 * the (dashboard) layout would be a RENDERING gate: requireRole() would still
 * pass for such a user, leaving every Server Action module callable by
 * whoever holds an intercepted temp password. So the redirect lives here.
 *
 * The split is deliberate: requireRole() redirects, getCurrentUser() does
 * not. The change-password flow resolves its caller with getCurrentUser(),
 * so it can never bounce itself into a redirect loop and no exemption
 * parameter is needed. /change-password also lives in the (auth) route
 * group, whose layout performs no session check, so the redirect cannot loop
 * through the dashboard gate either.
 */
export async function requireRole(allowedRoles: Role[]) {
  const user = await getCurrentUser();

  if (!user || !allowedRoles.includes(user.role)) {
    redirect("/unauthorized");
  }

  if (user.mustChangePassword) {
    redirect("/change-password");
  }

  return user;
}
