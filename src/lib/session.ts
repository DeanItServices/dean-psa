import type { Role } from "@prisma/client";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

/**
 * Returns the currently authenticated user (from the database-backed
 * session), or null if there is no session. This calls the full auth()
 * instance (Node runtime, Prisma-backed) -- only use from Server Components,
 * Server Actions, or Route Handlers, never from Edge middleware.
 */
export async function getCurrentUser() {
  const session = await auth();
  return session?.user ?? null;
}

/**
 * Authoritative, server-side role gate. Fail-secure: any missing session or
 * role not in the allow-list redirects to /unauthorized rather than letting
 * the caller proceed. This is the real authorization boundary for role
 * checks -- middleware only verifies a session cookie is present, it does
 * not evaluate roles.
 */
export async function requireRole(allowedRoles: Role[]) {
  const user = await getCurrentUser();

  if (!user || !allowedRoles.includes(user.role)) {
    redirect("/unauthorized");
  }

  return user;
}
