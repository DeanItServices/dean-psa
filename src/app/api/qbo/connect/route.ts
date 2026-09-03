import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { buildAuthorizeUrl } from "@/lib/qbo";

export const QBO_OAUTH_STATE_COOKIE = "qbo_oauth_state";

/**
 * Starts the "Connect to QuickBooks" OAuth2 flow.
 *
 * IMPORTANT: This Route Handler deliberately does NOT use requireRole() from
 * @/lib/session. requireRole() calls Next.js's redirect() from
 * next/navigation, which throws a special digest error that is only
 * intercepted by the Server Component / Server Action rendering pipeline.
 * A Route Handler is plain Request -> Response and is not part of that
 * pipeline, so calling requireRole() here would very likely surface as an
 * uncaught exception (500) rather than a clean redirect. Instead we gate
 * manually with getCurrentUser() + can() and return a NextResponse.redirect
 * directly.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();

  if (!user || !can(user.role, "qbo:manage")) {
    return NextResponse.redirect(new URL("/unauthorized", request.url));
  }

  // requireRole() enforces mustChangePassword for every Server Action, but
  // this handler deliberately cannot call it (see above), so the same gate is
  // repeated here -- otherwise a holder of an intercepted temp password could
  // still start the QuickBooks OAuth flow. Returned as a NextResponse
  // redirect, not next/navigation's redirect(), for the reason documented
  // above: redirect() throws a digest this pipeline does not intercept.
  if (user.mustChangePassword) {
    return NextResponse.redirect(new URL("/change-password", request.url));
  }

  const state = randomBytes(32).toString("hex");

  const response = NextResponse.redirect(buildAuthorizeUrl(state));

  // Short-lived, httpOnly cookie used solely to validate the `state` param
  // Intuit echoes back on the callback (CSRF mitigation for the OAuth
  // authorization-code flow).
  response.cookies.set(QBO_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 5, // 5 minutes
  });

  return response;
}
