import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { exchangeCodeForTokens } from "@/lib/qbo";
import { QBO_OAUTH_STATE_COOKIE } from "@/app/api/qbo/connect/route";

/**
 * Handles Intuit's OAuth2 redirect back to this app after the user
 * authorizes (or denies) the "Connect to QuickBooks" request.
 *
 * Like the connect route, this is a plain Route Handler -- no requireRole().
 * There is no meaningful "unauthenticated user" gate to apply here beyond
 * validating the CSRF state cookie, since only a session that itself
 * initiated /api/qbo/connect could have set that cookie.
 */
export async function GET(request: Request) {
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
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
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
