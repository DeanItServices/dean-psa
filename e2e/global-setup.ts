import { writeFileSync } from "node:fs";
import {
  E2E_EMAIL_LIKE,
  createFixtureSnapshotPath,
  describeEntryDrift,
  disconnectPrisma,
  readFixtureSnapshot,
  resolveE2eDatabaseUrl,
  sweepE2eAccounts,
  type FixtureBaseline,
} from "./db";
import { E2E_BASE_URL, E2E_SERVER_IS_EXTERNAL } from "./target";

/**
 * Runs once, in the runner process, before the first test.
 *
 * Four jobs, in this order:
 *   1. Refuse to run at all when the server and the database this process talks
 *      to are not the same system (see resolveE2eDatabaseUrl in db.ts). Checked
 *      first because it is the one failure that would make every other check
 *      here answer about the wrong deployment.
 *   2. Refuse to grade a server that is not running the code under test.
 *   3. Delete accounts a previous run orphaned.
 *   4. Snapshot the seeded fixtures so global teardown can diff against a real
 *      baseline, and report any drift the run INHERITED, which the diff by
 *      construction cannot see.
 *
 * A throw here aborts the run before a single browser opens, which is the
 * point: every one of these is a reason no result from this run would mean
 * anything.
 */

/**
 * BUILD-IDENTITY CANARY.
 *
 * `reuseExistingServer: false` stops Playwright ADOPTING a foreign server, but
 * it cannot help when the caller points E2E_BASE_URL somewhere themselves, and
 * it says nothing about whether a server Playwright did start is serving the
 * source in this working tree (a stale .next, a container bind-mount, a
 * different worktree on the same port). So the origin is asked to prove itself
 * before anything is asserted against it.
 *
 * The markers are the two DOM facts this review cycle added to /login -- the
 * `<main>` landmark from src/app/(auth)/layout.tsx and the real `<h1>` from
 * src/app/(auth)/login/page.tsx. /login is used because it is the only route
 * that renders identically to an unauthenticated fetch.
 *
 * THIS IS A CANARY, NOT A CONTRACT. It is checked here so a stale build fails
 * in the first second with a sentence naming the cause, instead of failing as
 * twenty confusing locator timeouts an hour later. If a future change removes
 * the landmark or the heading from /login deliberately, update these markers to
 * whatever the current build has that the previous one did not -- do not delete
 * the check, and do not weaken it to something both builds satisfy.
 */
const BUILD_MARKERS: { marker: string; why: string }[] = [
  { marker: "<main", why: "the (auth) layout's <main> landmark" },
  { marker: "<h1", why: "the real <h1> on /login (CardTitle asChild)" },
];

async function assertServedBuildIsCurrent(): Promise<void> {
  const url = `${E2E_BASE_URL}/login`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { "cache-control": "no-cache" } });
  } catch (cause) {
    throw new Error(
      `E2E build-identity check could not reach ${url}. ` +
        (E2E_SERVER_IS_EXTERNAL
          ? "E2E_BASE_URL is set, so this suite expects a server you started to already be listening there."
          : "Playwright was supposed to start this server itself; see the webServer output above.") +
        `\nCause: ${String(cause)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `E2E build-identity check: ${url} answered ${response.status}, expected 200. ` +
        "Something is listening there, but it is not this application's login page.",
    );
  }

  const html = await response.text();
  const missing = BUILD_MARKERS.filter(({ marker }) => !html.includes(marker));

  if (missing.length > 0) {
    throw new Error(
      [
        `E2E build-identity check FAILED against ${url}.`,
        `Missing from the served /login: ${missing
          .map(({ marker, why }) => `${marker} (${why})`)
          .join(", ")}.`,
        "",
        "The server answering there is NOT running the source in this working tree.",
        "The usual cause is another process already holding the port -- on this",
        "machine the dean-psa-app-1 container publishes 3000 from a previously",
        "built image. Grading it would report on that build, not on this one.",
        "",
        "Fix: stop the other server, or set E2E_PORT to a free port. Do not",
        "delete this check to get a green run.",
      ].join("\n"),
    );
  }

  console.log(
    `[e2e] build-identity check passed: ${url} serves the current source ` +
      `(${BUILD_MARKERS.map(({ marker }) => marker).join(", ")} present).`,
  );
}

export default async function globalSetup(): Promise<void> {
  // Throws when E2E_BASE_URL names a foreign server without E2E_DATABASE_URL
  // naming its database. Called explicitly, before the first query, so the
  // failure is a sentence about the coupling rather than a Prisma error
  // against the wrong host halfway through the sweep.
  resolveE2eDatabaseUrl();

  await assertServedBuildIsCurrent();

  try {
    const swept = await sweepE2eAccounts();
    if (swept > 0) {
      console.warn(
        `[e2e] swept ${swept} orphaned account(s) matching ${E2E_EMAIL_LIKE} left by a previous run. ` +
          "Each was a live account on a plaintext-HTTP instance; see e2e/db.ts.",
      );
    }

    const snapshot = await readFixtureSnapshot();

    // ENTRY DRIFT. The teardown diff can only prove this run added no damage:
    // its "before" is whatever is here now, so anything already wrong is
    // copied into the baseline and blessed. This is the one place the run can
    // say what it INHERITED. See SEEDED_FIXTURE_ENTRY_STATE in db.ts for why
    // this warns rather than fails, and why tokenVersion gets no invariant.
    const entryDrift = describeEntryDrift(snapshot);

    const baseline: FixtureBaseline = {
      recordedAt: new Date().toISOString(),
      entryDrift,
      snapshot,
    };

    // Run-scoped path, and the teardown now ERRORS if it is missing: the fixed
    // path made the whole diff skippable with one `rm`, silently and greenly.
    const snapshotPath = createFixtureSnapshotPath();
    writeFileSync(snapshotPath, JSON.stringify(baseline, null, 2), "utf8");

    console.log(
      `[e2e] seeded-fixture baseline recorded for ${Object.keys(snapshot).length} account(s) ` +
        `at ${snapshotPath}.`,
    );

    if (entryDrift.length > 0) {
      console.warn(
        [
          `[e2e] ENTRY DRIFT: ${entryDrift.length} seeded-fixture value(s) already differ from`,
          "what prisma/seed.ts writes, BEFORE this run did anything:",
          ...entryDrift.map((line) => `  - ${line}`),
          "This run's end-state diff takes the state above as its baseline, so it will",
          "report these as unchanged. Not a failure: a password change legitimately moves",
          "tokenVersion, and the four fields that must never drift are hard-failed at",
          "teardown. Re-run `npm run db:seed` against a fresh database to clear it.",
        ].join("\n"),
      );
    }
  } finally {
    await disconnectPrisma();
  }
}
