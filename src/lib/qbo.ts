import { db } from "@/lib/db";

/**
 * Thin fetch-based QuickBooks Online OAuth2 client. No SDK -- Intuit's
 * OAuth2 flow is plain authorization-code + refresh-token grant against a
 * standard token endpoint, so a wrapper library is unnecessary surface area.
 *
 * This module only establishes and maintains the connection (token
 * exchange/refresh + a lazy-refreshing accessor). It intentionally does NOT
 * implement any QBO Accounting API calls (e.g. pushing invoices) -- that is
 * Plan 04-06's responsibility, built on top of getValidQboClient().
 *
 * Endpoint hosts below are Intuit's publicly documented OAuth2 endpoints:
 * - Authorization: https://appcenter.intuit.com/connect/oauth2
 * - Token exchange/refresh: https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
 */

const QBO_TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QBO_AUTHORIZE_ENDPOINT = "https://appcenter.intuit.com/connect/oauth2";
const QBO_SCOPE = "com.intuit.quickbooks.accounting";

// Refresh proactively if the token expires within this window.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

function getClientCredentials() {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set to use the QuickBooks integration.",
    );
  }

  return { clientId, clientSecret };
}

function getBasicAuthHeader(): string {
  const { clientId, clientSecret } = getClientCredentials();
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function getRedirectUri(): string {
  const redirectUri = process.env.QBO_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error("QBO_REDIRECT_URI must be set to use the QuickBooks integration.");
  }
  return redirectUri;
}

interface QboTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
  token_type?: string;
}

/**
 * Exchanges an OAuth2 authorization code (received on the callback route)
 * for an access/refresh token pair. realmId is NOT returned by the token
 * endpoint -- Intuit sends it as a separate query parameter on the callback
 * redirect, so the caller must pass that through separately.
 */
export async function exchangeCodeForTokens(
  code: string,
): Promise<{ accessToken: string; refreshToken: string; realmId: string; expiresIn: number }> {
  const redirectUri = getRedirectUri();

  const response = await fetch(QBO_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: getBasicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `QuickBooks token exchange failed (${response.status}): ${body || response.statusText}`,
    );
  }

  const data = (await response.json()) as QboTokenResponse;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // realmId is not part of the token response; the callback route supplies
    // it from the `realmId` query param and merges it in separately.
    realmId: "",
    expiresIn: data.expires_in,
  };
}

/**
 * Exchanges a refresh token for a new access/refresh token pair.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(QBO_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: getBasicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `QuickBooks token refresh failed (${response.status}): ${body || response.statusText}`,
    );
  }

  const data = (await response.json()) as QboTokenResponse;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Returns a valid (non-expired) access token + realmId for the single
 * QuickBooksConnection row, transparently refreshing and persisting a new
 * access token if the current one is expired or within the refresh skew
 * window. Returns null (never throws) if there is no connection yet, or if
 * the refresh attempt itself fails -- callers should treat null as "QBO is
 * not currently connected/usable" rather than an error condition.
 */
export async function getValidQboClient(): Promise<{ accessToken: string; realmId: string } | null> {
  const connection = await db.quickBooksConnection.findFirst();

  if (!connection) {
    return null;
  }

  const expiresAt = connection.accessTokenExpiresAt.getTime();
  const needsRefresh = expiresAt - Date.now() <= REFRESH_SKEW_MS;

  if (!needsRefresh) {
    return { accessToken: connection.accessToken, realmId: connection.realmId };
  }

  try {
    const refreshed = await refreshAccessToken(connection.refreshToken);

    const updated = await db.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        accessTokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      },
    });

    return { accessToken: updated.accessToken, realmId: updated.realmId };
  } catch (err) {
    console.error("QBO token refresh failed:", err);
    return null;
  }
}

/**
 * Builds Intuit's OAuth2 authorization URL for the "Connect to QuickBooks"
 * flow. `state` is an opaque CSRF token the caller generates, stores in a
 * short-lived cookie, and validates on the callback.
 */
export function buildAuthorizeUrl(state: string): string {
  const { clientId } = getClientCredentials();
  const redirectUri = getRedirectUri();

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: QBO_SCOPE,
    redirect_uri: redirectUri,
    state,
  });

  return `${QBO_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}
