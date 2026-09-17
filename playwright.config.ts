import { defineConfig } from "@playwright/test";
import { E2E_BASE_URL, E2E_PORT, E2E_SERVER_IS_EXTERNAL } from "./e2e/target";

/**
 * Playwright E2E configuration.
 *
 * Specs run against a locally-started `next dev` server (via `webServer`
 * below) targeting the local dev database -- no separate test-database
 * strategy is introduced (see 06-CONTEXT.md's locked "Playwright E2E
 * approach"). `e2e/fixtures.ts` holds the shared login helpers; `e2e/db.ts`
 * holds the shared database access used by the specs and by the two global
 * hooks.
 *
 * WHICH SERVER IS GRADED. Resolved entirely in e2e/target.ts, which documents
 * the stale-container failure this replaced and the three defences against it.
 * The two that live here:
 *
 *   - `reuseExistingServer: false`, ALWAYS -- not `!process.env.CI`. Reuse is
 *     what let a run silently adopt the container already listening on :3000
 *     and grade a previously-built image. Playwright now starts its own server
 *     or fails saying the port is busy; there is no third outcome.
 *   - `webServer` is dropped entirely when E2E_BASE_URL names a caller-managed
 *     server, because starting a second one would be wrong -- and
 *     e2e/global-setup.ts's build-identity check still runs against it.
 *
 * PROJECTS, AND WHY THEY ARE NOT COSMETIC.
 *
 *   lifecycle  -- Phase 7's blocking gate (@user-lifecycle). THREE files:
 *                 user-lifecycle.spec.ts, bootstrap-admin.spec.ts and
 *                 harness.spec.ts (which tests this suite's own two
 *                 silent-wrong-answer helpers, and so belongs to the run whose
 *                 conclusions they decide).
 *
 *                 WHY BOOTSTRAP LIVES HERE AND NOT IN A PROJECT OF ITS OWN,
 *                 which is the shape that would otherwise be tidier. It creates
 *                 ADMIN accounts with real passwords, briefly, exactly as
 *                 user-lifecycle.spec.ts does -- and `last-active-admin` below
 *                 is only correct while the seeded admin is the ONLY admin who
 *                 can still log in. That is guaranteed by its
 *                 `dependencies: ["lifecycle"]`, which waits for this whole
 *                 project. A separate project would run CONCURRENTLY with
 *                 last-active-admin and break its precondition -- silently, as
 *                 a "the guard rail did not fire" failure in a spec with
 *                 nothing to do with the cause.
 *
 *                 It is also why the testMatch is a two-file alternation rather
 *                 than a directory: adding a spec to this project is a decision
 *                 about admin accounts, not a filename convention.
 *   advisory   -- tickets, sla-tracking and time-entry-to-invoice: 8 tests in
 *                 3 files. THE NAME IS NOW HISTORICAL: they are in the gate,
 *                 and `npm run test:e2e` fails if they fail. It is kept only
 *                 because renaming a project renames it in every report and CI
 *                 selector that already refers to it. "The three pre-Phase-7
 *                 specs" is a stale label for the same reason -- the three
 *                 FILES predate Phase 7, but three of the eight tests (the
 *                 ticket-delete cases) were written in Phase 9.
 *
 *                 IT RUNS CONCURRENTLY WITH `lifecycle`, and that is safe for
 *                 the one reason that matters here: it mutates no `User` rows,
 *                 so it cannot break `last-active-admin`'s precondition that
 *                 the seeded admin is the only admin who can still log in.
 *                 Checked rather than assumed -- the only Prisma models these
 *                 three specs touch are Company, Ticket, TimeEntry, Invoice and
 *                 InvoiceLineItem, and none of them calls the one non-admin
 *                 app path that writes a User row (logoutAction's tokenVersion
 *                 increment, src/app/(auth)/login/actions.ts). They only ever
 *                 log IN, as the seeded fixtures. Adding a spec here that
 *                 creates, deactivates or re-roles an account is therefore the
 *                 same decision as adding one to `lifecycle` below -- see that
 *                 project's note.
 *
 *                 This comment used to say they had "never been run against a
 *                 browser" and that "ROADMAP Phase 9 owns their first real run
 *                 and fixing what breaks". 09-01 did the running (1 passed, 4
 *                 failed, 2 skipped -- the first execution in the project's
 *                 history) and Plan 09-04 did the fixing. Every failure was in
 *                 the specs, not the product: one shared rate-limit bucket,
 *                 one `waitForURL` regex that also matched the `/new` form the
 *                 page was already on, two locators that matched a visible
 *                 element and a hidden duplicate, one assertion on a heading
 *                 role that does not exist, a 65s wait inside a 30s budget, a
 *                 stranded timer row that poisoned every later run, and a
 *                 negative assertion standing in for a wait.
 *
 *                 They were excluded from the gate while they were red,
 *                 because a permanently red gate has no signal. That reason
 *                 expired when they went green, so they were folded in: the
 *                 gate went from 45 tests to 53 and, until then, said nothing
 *                 at all about ticket delete.
 *   last-active-admin -- runs only after `lifecycle` has finished, because it
 *                 CANNOT be correct while another spec holds a second active
 *                 admin open. See the spec's own header: its precondition is
 *                 that the seeded admin is the only admin who can still log in,
 *                 and `lifecycle` creates admins that break exactly that.
 *                 `fullyParallel: false` so it is also alone within its project.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "lifecycle",
      testMatch: /(user-lifecycle|bootstrap-admin|harness)\.spec\.ts$/,
    },
    {
      name: "advisory",
      testMatch: /(tickets|sla-tracking|time-entry-to-invoice)\.spec\.ts$/,
    },
    {
      name: "last-active-admin",
      testMatch: /last-active-admin\.spec\.ts$/,
      dependencies: ["lifecycle"],
      fullyParallel: false,
    },
  ],
  webServer: E2E_SERVER_IS_EXTERNAL
    ? undefined
    : {
        command: `npm run dev -- --port ${E2E_PORT}`,
        url: E2E_BASE_URL,
        reuseExistingServer: false,
        // A cold Turbopack start plus the first on-demand compile of /login is
        // comfortably slower than the old 60s on a loaded machine, and a
        // timeout here reads as an unexplained infrastructure failure.
        timeout: 120_000,
        // stderr only: piping stdout would interleave every request line of
        // the dev server's access log into the test report.
        stderr: "pipe",
      },
});
