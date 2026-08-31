import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

/**
 * Edge-safe route protection. This imports ONLY the Edge-safe base config
 * (./auth.config) -- never the full Node auth module, which pulls in the
 * Prisma adapter and cannot run in the Edge runtime.
 *
 * This performs a coarse, fast check: "is there a session at all?" (via the
 * `authorized` callback in auth.config.ts), redirecting to /login if not.
 * It does NOT perform role-based authorization -- that is the job of
 * requireRole() in src/lib/session.ts, called server-side (Node runtime)
 * from protected Server Components/layouts. Treat middleware as UX-speed
 * defense only, never as the authoritative permission boundary.
 */
export default NextAuth(authConfig).auth;

export const config = {
  matcher: ["/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)"],
};
