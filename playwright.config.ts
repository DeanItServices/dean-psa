import { defineConfig } from "@playwright/test";

/**
 * Playwright E2E configuration.
 *
 * Specs run against a locally-started `next dev` server (via `webServer`
 * below) targeting the local dev database -- no separate test-database
 * strategy is introduced (see 06-CONTEXT.md's locked "Playwright E2E
 * approach"). Wave 2's spec plans (06-06/06-07/06-08) import
 * `e2e/fixtures.ts` for shared login/seed-data helpers rather than
 * reimplementing Auth.js login navigation themselves.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
