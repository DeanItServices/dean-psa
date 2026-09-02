import type { Role } from "@prisma/client";
import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
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
    },
  });
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
 * FAIL CLOSED: if the lookup throws it is deliberately NOT caught. We never
 * fall back to the JWT's `role` claim -- that would restore the staleness bug
 * at exactly the moment the database cannot contradict it. Letting the throw
 * propagate is fail-closed (no user object is ever produced, so nothing
 * downstream grants access) and it is legible: a database outage, or a P2022
 * raised because the isActive/mustChangePassword migration has not been
 * applied to this environment, surfaces as an error instead of masquerading
 * as every user being silently logged out.
 *
 * This performs a Prisma query and calls the full auth() instance, so this
 * module is strictly Node-runtime: use it from Server Components, Server
 * Actions and Route Handlers only -- never from Edge middleware.
 */
export async function getCurrentUser() {
  const session = await auth();
  const id = session?.user?.id;

  // Reject anything that is not a usable id before touching the database.
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }

  const user = await findSessionUser(id);

  if (!user || !user.isActive) {
    return null;
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
