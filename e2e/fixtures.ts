import type { Page } from "@playwright/test";

/**
 * Shared E2E helpers for Wave 2's spec plans (06-06 ticket lifecycle,
 * 06-07 time entry to invoice, 06-08 SLA tracking).
 *
 * This file is a helper module only -- it contains no `test`/`expect`
 * calls and is not itself a `.spec.ts` file, so Playwright's test runner
 * does not try to execute it directly.
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
 */
export async function loginAs(
  page: Page,
  role: keyof typeof ROLE_CREDENTIALS,
): Promise<void> {
  const { email, password } = ROLE_CREDENTIALS[role];

  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForURL((url) => !url.pathname.includes("/login"));
}
