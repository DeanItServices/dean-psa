import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Shared E2E helpers: login, hydration, and per-context client identity.
 *
 * Used by 06-06 (ticket lifecycle), 06-07 (time entry to invoice), 06-08 (SLA
 * tracking) and Phase 7's user-lifecycle and last-active-admin specs.
 *
 * This file declares no `test()` and is not a `.spec.ts`, so Playwright's
 * testMatch never executes it. It does import `test` -- solely for
 * `test.info().workerIndex`, which is what gives each worker a distinct client
 * identity (see `isolatedClientHeaders`).
 */

/**
 * Seeded local-dev test-user credentials, one per role, from
 * `prisma/seed.ts` (cross-referenced against `.planning/STATE.md`, which
 * documents the same email pattern and shared password). These accounts
 * only exist in a local/dev database seeded via `npm run db:seed` -- the
 * seed script itself refuses to run with `NODE_ENV=production` unless
 * explicitly overridden. Never valid outside local dev.
 */
export const ROLE_CREDENTIALS: Record<
  "technician" | "dispatcher" | "sales" | "finance" | "admin",
  { email: string; password: string }
> = {
  technician: { email: "technician@mspdemo.local", password: "Password123!" },
  dispatcher: { email: "dispatcher@mspdemo.local", password: "Password123!" },
  sales: { email: "sales@mspdemo.local", password: "Password123!" },
  finance: { email: "finance@mspdemo.local", password: "Password123!" },
  admin: { email: "admin@mspdemo.local", password: "Password123!" },
};

// ---------------------------------------------------------------------------
// Per-context client identity
// ---------------------------------------------------------------------------

/**
 * The X-Forwarded-For value each browser context sends.
 *
 * NOT a convenience, and not masking a failure this suite should be reporting.
 * src/middleware.ts rate-limits per IP -- 60 requests per 60 seconds generally,
 * 10 for a POST to /login -- and its `getClientIp()` falls back to the literal
 * key "unknown" when no X-Forwarded-For or X-Real-IP header is present. With no
 * reverse proxy in front of the app -- the topology this repo's
 * docker-compose.yml ships, as middleware.ts itself documents at length -- every
 * browser context in every spec would share ONE budget. A Server Action POST
 * that receives a 429 rejects in the browser and 07-05's handlers turn that into
 * "Something went wrong. Please try again.", which is indistinguishable from a
 * genuine guard-rail bug at the assertion.
 *
 * READ THIS BEFORE TRUSTING ANY RATE-LIMIT CONCLUSION FROM THIS SUITE. Setting
 * this header is itself a demonstration of the finding: any client can mint a
 * fresh rate-limit bucket with one header, so NO result from this suite
 * reflects the shipped topology's rate limiting. That is a Phase 8 input (put a
 * reverse proxy in front that overwrites these headers), not something a test
 * can fix -- and the alternative here is an unrunnable suite, because the
 * limiter would fire on the suite's own traffic long before any assertion.
 *
 * CORRECTED THIS CYCLE. The second octet used to be `Math.random()` evaluated at
 * module load, i.e. once per worker process, with the third octet counting up
 * from 1 in each. Two workers drawing the same random octet therefore issued
 * IDENTICAL addresses and shared a bucket -- a ~0.4% flake per worker pair, and
 * one that would surface as an unrelated "Something went wrong". `workerIndex`
 * is unique across the workers of a run by construction, so the collision is
 * gone rather than made rarer.
 *
 * Addresses come from 198.18.0.0/15, the RFC 2544 benchmarking range, which is
 * not routable.
 */
let ipCounter = 0;

function isolatedClientHeaders(): Record<string, string> {
  ipCounter += 1;
  const worker = test.info().workerIndex + 1;
  return { "x-forwarded-for": `198.18.${worker}.${ipCounter}` };
}

/**
 * The headers a context was created with, so a direct `context.request` call
 * carries the same client identity as the pages in that context. Without this
 * an out-of-band Server Action invocation would land in a different rate-limit
 * bucket from the browsing that set it up.
 */
const contextHeaders = new WeakMap<BrowserContext, Record<string, string>>();

export function clientHeaders(context: BrowserContext): Record<string, string> {
  const headers = contextHeaders.get(context);
  if (!headers) {
    throw new Error(
      "this BrowserContext was not created by newIsolatedContext(), so it has no " +
        "recorded client identity. Create contexts with that helper so direct " +
        "context.request calls share the pages' rate-limit bucket.",
    );
  }
  return headers;
}

/** A browser context with its own rate-limit bucket and the configured baseURL. */
export async function newIsolatedContext(browser: Browser): Promise<BrowserContext> {
  const headers = isolatedClientHeaders();
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    extraHTTPHeaders: headers,
  });
  contextHeaders.set(context, headers);
  return context;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Blocks until React has hydrated the form on the current page.
 *
 * WHY EVERY LOGIN GOES THROUGH THIS. /login is a client component whose
 * `<form>` has an `onSubmit` handler and NO `action` or `method`. Submit it
 * before hydration and the browser performs the HTML default: a GET to the
 * page's own URL with every field in the query string. Observed directly while
 * building this suite, in a dev server's own access log:
 *
 *   GET /login?email=admin%40mspdemo.local&password=Password123%21 200
 *
 * For the test that is a hang (the URL never becomes "/"), and it is also how
 * the failure presents: a login timeout that looks like an auth bug. That the
 * same window puts a plaintext password into the URL, the browser history and
 * the server log is a product finding referred to the owner of
 * src/app/(auth)/login/page.tsx -- this helper only makes the suite stop
 * triggering it.
 *
 * Hydration is detected by React's own marker: the props bag React attaches to
 * a DOM node it controls. Established empirically against this build. If a
 * future React stops using that key this times out with the message below
 * rather than silently reverting to unhydrated submits.
 */
export async function waitForHydration(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    (sel) => {
      const element = document.querySelector(sel);
      return !!element && Object.keys(element).some((key) => key.startsWith("__reactProps$"));
    },
    selector,
    { timeout: 30_000 },
  );
}

/**
 * Fills and submits the login form, after hydration.
 *
 * Shared by the three helpers below so the hydration guard cannot be forgotten
 * on one of them.
 */
async function submitLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await waitForHydration(page, "#email");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Logs `page` in as the given seeded role via the real login form at
 * `/login` (src/app/(auth)/login/page.tsx).
 *
 * Real, confirmed field selectors (read from source, not assumed):
 * - Email input: `#email` (also `name="email"`, `type="email"`)
 * - Password input: `#password` (also `name="password"`, `type="password"`)
 * - Submit button: `type="submit"`, accessible name "Sign in"
 *
 * On successful login, `LoginPage`'s `handleSubmit` calls
 * `router.push("/")`, navigating away from `/login`. This helper waits for
 * that redirect before resolving, so callers can assume the session is
 * established when `loginAs` returns.
 *
 * On a login failure, the page shows an inline error and stays on
 * `/login` -- `waitForURL` will then time out per Playwright's default
 * action timeout, surfacing a clear test failure. No custom
 * infinite-retry loop is added.
 *
 * The landing pathname is then asserted to be exactly `/`. A weaker
 * "left /login" check is also satisfied by `/change-password`, where a
 * seeded account carrying `mustChangePassword` is now redirected -- the
 * helper would resolve "successfully" and every downstream spec would fail
 * with an unrelated locator timeout instead of naming the real cause.
 */
export async function loginAs(
  page: Page,
  role: keyof typeof ROLE_CREDENTIALS,
): Promise<void> {
  const { email, password } = ROLE_CREDENTIALS[role];

  await submitLogin(page, email, password);
  await page.waitForURL((url) => url.pathname !== "/login");

  const pathname = new URL(page.url()).pathname;

  if (pathname !== "/") {
    throw new Error(
      `loginAs("${role}") expected to land on "/" after sign-in but landed on "${pathname}".` +
        (pathname === "/change-password"
          ? ` The seeded ${email} account has mustChangePassword set;` +
            ` re-run \`npm run db:seed\` (prisma/seed.ts sets isActive/mustChangePassword explicitly).`
          : ""),
    );
  }
}

/**
 * Logs `page` in with EXPLICIT credentials and asserts the landing pathname,
 * for accounts a spec creates itself rather than the five seeded fixtures.
 *
 * WHY THIS EXISTS ALONGSIDE `loginAs` RATHER THAN REPLACING IT. `loginAs`
 * asserts the post-login pathname is exactly `/`. That is correct for the
 * seeded accounts and is the assertion that turns a broken seed into a named
 * failure instead of an unrelated locator timeout three steps downstream. A
 * user created through /admin/users carries `mustChangePassword: true`, so
 * the (dashboard) layout bounces them to `/change-password` and they will
 * never reach `/`. Weakening `loginAs` to accommodate that would delete a
 * real guard rail from three other specs to serve this one; a second helper
 * carrying an explicit expectation does not.
 *
 * @param options.expectPath the pathname login must land on. Defaults to
 *   `/`. Pass `"/change-password"` for an account holding a temporary
 *   password.
 */
export async function loginWith(
  page: Page,
  email: string,
  password: string,
  options: { expectPath?: string } = {},
): Promise<void> {
  const expectPath = options.expectPath ?? "/";

  await submitLogin(page, email, password);
  await page.waitForURL((url) => url.pathname === expectPath);
}

/**
 * Attempts a login that is EXPECTED TO FAIL and returns the visible message.
 *
 * The page stays on `/login` and renders the failure in a `role="alert"`
 * paragraph (src/app/(auth)/login/page.tsx). The text is returned rather than
 * asserted here so the caller names the claim it is making about it.
 */
export async function loginExpectingFailure(
  page: Page,
  email: string,
  password: string,
): Promise<string> {
  await submitLogin(page, email, password);

  // Scoped to the form's own `<p role="alert">`, NOT `getByRole("alert")`:
  // Next.js renders a permanent `<div role="alert" id="__next-route-announcer__">`
  // on every page, which is present and technically visible with empty text.
  // Matching it returned "" instead of the login error -- observed directly.
  const alert = page.locator('p[role="alert"]');
  await alert.waitFor({ state: "visible" });

  return ((await alert.textContent()) ?? "").trim();
}
