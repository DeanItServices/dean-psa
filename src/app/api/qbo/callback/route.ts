import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { exchangeCodeForTokens } from "@/lib/qbo";
import { encrypt } from "@/lib/crypto";
import { QBO_OAUTH_STATE_COOKIE } from "@/app/api/qbo/connect/route";

/**
 * Handles Intuit's OAuth2 redirect back to this app after the user
 * authorizes (or denies) the "Connect to QuickBooks" request.
 *
 * Like the connect route, this is a plain Route Handler, so it cannot call
 * requireRole(): that helper uses next/navigation's redirect(), whose thrown
 * digest only the Server Component / Server Action pipeline intercepts. It
 * gates manually and returns NextResponse.redirect instead -- the same
 * three-check gate connect/route.ts uses, and for the same reasons.
 *
 * CORRECTED (review cycle 2). An earlier comment here claimed the CSRF state
 * cookie was gate enough, "since only a session that itself initiated
 * /api/qbo/connect could have set that cookie". That was wrong in a way that
 * mattered: the cookie proves a connect request happened, not that THIS
 * requester is still authorized. It survives deactivation, demotion and
 * sign-out for its full 5-minute life, and it is not scoped to a user at all.
 * Meanwhile the handler below unconditionally deleteMany()s the single
 * QuickBooksConnection row and recreates it from a query-string `realmId` --
 * so anyone who could replay or obtain that cookie could repoint the
 * organisation's QuickBooks integration at a realm of their choosing. The
 * state check stays (it is CSRF protection and still necessary); it is now
 * layered behind a real authorization check rather than substituting for one.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();

  if (!user || !can(user.role, "qbo:manage")) {
    return NextResponse.redirect(new URL("/unauthorized", request.url));
  }

  if (user.mustChangePassword) {
    return NextResponse.redirect(new URL("/change-password", request.url));
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");
  const error = url.searchParams.get("error");

  const adminQboUrl = new URL("/admin/quickbooks", request.url);

  // Intuit surfaces user-declined consent (or other authorization errors) as
  // an `error` query param rather than omitting `code` silently.
  if (error) {
    adminQboUrl.searchParams.set("qbo_error", error);
    const response = NextResponse.redirect(adminQboUrl);
    response.cookies.delete(QBO_OAUTH_STATE_COOKIE);
    return response;
  }

  const cookieStore = await cookies();
  const cookieState = cookieStore.get(QBO_OAUTH_STATE_COOKIE)?.value;

  if (!state || !cookieState || state !== cookieState) {
    adminQboUrl.searchParams.set("qbo_error", "state_mismatch");
    const response = NextResponse.redirect(adminQboUrl);
    response.cookies.delete(QBO_OAUTH_STATE_COOKIE);
    return response;
  }

  if (!code || !realmId) {
    adminQboUrl.searchParams.set("qbo_error", "missing_params");
    const response = NextResponse.redirect(adminQboUrl);
    response.cookies.delete(QBO_OAUTH_STATE_COOKIE);
    return response;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const accessTokenExpiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

    // Guarantee at most one QuickBooksConnection row ever exists: clear any
    // existing row(s), then create a fresh one from this authorization.
    await db.quickBooksConnection.deleteMany({});
    await db.quickBooksConnection.create({
      data: {
        realmId,
        accessToken: encrypt(tokens.accessToken),
        refreshToken: encrypt(tokens.refreshToken),
        accessTokenExpiresAt,
      },
    });

    adminQboUrl.searchParams.set("qbo_connected", "1");
    const response = NextResponse.redirect(adminQboUrl);
    response.cookies.delete(QBO_OAUTH_STATE_COOKIE);
    return response;
  } catch {
    adminQboUrl.searchParams.set("qbo_error", "token_exchange_failed");
    const response = NextResponse.redirect(adminQboUrl);
    response.cookies.delete(QBO_OAUTH_STATE_COOKIE);
    return response;
  }
}
