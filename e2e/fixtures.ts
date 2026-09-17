import { test as base, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Shared E2E helpers: login, hydration, and per-context client identity.
 *
 * Used by 06-06 (ticket lifecycle), 06-07 (time entry to invoice), 06-08 (SLA
 * tracking) and Phase 7's user-lifecycle and last-active-admin specs.
 *
 * This file declares no `test()` CASE and is not a `.spec.ts`, so Playwright's
 * testMatch never executes it. It does import the base `test` object -- for
 * `base.info().workerIndex`, which is what gives each worker a distinct client
 * identity (see `isolatedClientHeaders`), and to export the extended `test`
 * below that hands the built-in `page` fixture its own rate-limit bucket.
 */

/**
 * Seeded local-dev test-user credentials, one per role, from
 * `prisma/seed.ts` (cross-referenced against `.planning/STATE.md`, which
 * documents the same email pattern and shared password). These accounts
 * only exist in a local/dev database seeded via
 * `ALLOW_DEMO_SEED=true npm run db:seed` -- the seed script refuses to run
 * anywhere without that exact opt-in on the command line (the older
 * NODE_ENV/ALLOW_SEED_IN_PRODUCTION gate is gone). Never valid outside local
 * dev.
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
 * src/proxy.ts rate-limits per IP -- 60 requests per 60 seconds generally,
 * 10 for a POST to /login. NOTE, this comment predates Phase 8 and the two
 * facts it rested on are both gone: `getClientIp()` no longer falls back to a
 * shared "unknown" key (it returns null and the caller SKIPS limiting -- see
 * "Do not restore a shared fallback key" in src/proxy.ts), and
 * docker-compose.yml now ships Caddy in front of an app that publishes no port.
 * The shared-budget hazard described below is therefore historical for the
 * deployed topology; it is retained because a direct-to-app dev server still
 * has no proxy setting the header, which is the case this suite runs in. A Server Action POST
 * that receives a 429 rejects in the browser and 07-05's handlers turn that into
 * "Something went wrong. Please try again.", which is indistinguishable from a
 * genuine guard-rail bug at the assertion.
 *
 * READ THIS BEFORE TRUSTING ANY RATE-LIMIT CONCLUSION FROM THIS SUITE. Setting
 * this header is itself a demonstration of the finding: any client can mint a
 * fresh rate-limit bucket with one header, so NO result from this suite
 * reflects the shipped topology's rate limiting. Phase 8 fixed that FOR THE
 * DEPLOYED STACK -- the Caddyfile now overwrites both X-Forwarded-For and
 * X-Real-IP with the peer address, so a forged header buys nothing there. It
 * does not, and cannot, change anything here: this suite talks straight to a
 * dev server with no proxy in front, so the header is still whatever the test
 * sends. The alternative is an unrunnable suite, because the limiter would fire
 * on the suite's own traffic long before any assertion.
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
  const worker = base.info().workerIndex + 1;
  return { "x-forwarded-for": `198.18.${worker}.${ipCounter}` };
}

/**
 * `test`, with the built-in `page`/`context` fixture given its own rate-limit
 * bucket. Import this instead of `@playwright/test`'s `test` and a spec using
 * the bare `{ page }` fixture gets the same isolation `newIsolatedContext()`
 * gives a hand-built context.
 *
 * WHY THIS EXISTS AT ALL, rather than each spec calling `newIsolatedContext`.
 * Before Phase 9 that helper was the ONLY way to get a bucket, so it was
 * available only to specs that built their own context. The three pre-Phase-7
 * specs use `{ page }`, so all three shared ONE bucket -- src/proxy.ts allows
 * 60 requests per IP per 60s, and a suite driving a real browser through
 * multi-step workflows blows through that in under a minute. The failure is
 * not a clean error: a Server Action POST that is 429'd rejects in the browser
 * and the page simply never updates, so it presents as an unrelated 30s
 * locator timeout, or -- worse -- as a write that silently never persisted.
 * 09-01 proved the mechanism by raising RATE_LIMIT_* and watching
 * `assignedToId` go from empty to populated with no code change.
 *
 * HOW FAR THE OVERRIDE ACTUALLY REACHES -- measured, because the mechanism is
 * not the one the shape of this code suggests. Overriding the
 * `extraHTTPHeaders` option is a single root fix rather than one edit per call
 * site, and a spec opts in by changing its import line.
 *
 * It reaches EVERY BrowserContext created during a test, not just the built-in
 * `context`/`page` fixtures -- including one built by a bare
 * `browser.newContext()` with no options. That is worth stating because the
 * obvious reading of Playwright's source says otherwise: the merged value
 * lands in the internal `_combinedContextOptions` fixture, and the only
 * consumer that LOOKS relevant is `_contextFactory`, which only `context` and
 * `page` use. The reach comes from somewhere else -- `_setupArtifacts`
 * installs a `runBeforeCreateBrowserContext` hook
 * (node_modules/playwright/lib/index.js) that copies every
 * `_combinedContextOptions` key into any context's options unless that key was
 * passed explicitly.
 *
 * Verified rather than reasoned about, with a throwaway spec that intercepted
 * the outgoing request in each case:
 *   - `{ page }` fixture        -> x-forwarded-for: 198.18.1.1
 *   - bare `browser.newContext()` in the same test -> x-forwarded-for: 198.18.1.1
 *
 * Note the second line carefully: the raw context inherits the SAME address,
 * it does not mint a new one. `isolatedClientHeaders()` runs once per fixture
 * resolution, so a test that drives both `{ page }` and a hand-built context
 * spends ONE 60-request budget across both. `newIsolatedContext()` passes
 * `extraHTTPHeaders` explicitly, which is why it still wins over the inherited
 * value and still gets a bucket of its own -- that is what makes it the right
 * helper for a spec that opens several contexts, and the reason to keep using
 * it rather than a bare `browser.newContext()`.
 *
 * `test.use({ extraHTTPHeaders: ... })` in a spec does NOT compose with this --
 * it REPLACES it, silently returning that spec to the shared bucket. Also
 * measured: with `test.use({ extraHTTPHeaders: { "x-probe": ... } })` in
 * force, the outgoing request carried the probe header and NO
 * x-forwarded-for at all. The cause is that the override below is a plain
 * fixture and deliberately drops `{ option: true }`, so `test.use` supplies a
 * constant that shadows this function instead of feeding it. If a spec ever
 * needs extra headers, add them inside this fixture, not through `test.use`.
 */
export const test = base.extend({
  // The second parameter is Playwright's fixture-provider callback, which its
  // docs conventionally name `use`. It is named `provide` here ONLY because
  // eslint-config-next's react-hooks/rules-of-hooks reads a bare `use(...)`
  // call as React 19's `use` hook and fails the lint with "React Hook `use` is
  // called in function `extraHTTPHeaders`". Playwright passes this argument
  // positionally, so the name is free -- renaming it keeps `npm run lint` at
  // zero problems without suppressing a rule anywhere. Do not "restore" it to
  // `use`.
  extraHTTPHeaders: async (
    { extraHTTPHeaders }: { extraHTTPHeaders: Record<string, string> | undefined },
    provide: (headers: Record<string, string>) => Promise<void>,
  ) => {
    await provide({ ...extraHTTPHeaders, ...isolatedClientHeaders() });
  },
});

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
    baseURL: base.info().project.use.baseURL,
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
            ` re-run \`ALLOW_DEMO_SEED=true npm run db:seed\` (prisma/seed.ts sets isActive/mustChangePassword explicitly).`
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
