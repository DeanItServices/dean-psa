import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  E2E_EMAIL_LIKE,
  FIXTURE_SNAPSHOT_PATH,
  SEEDED_FIXTURES,
  disconnectPrisma,
  readFixtureSnapshot,
  sweepE2eAccounts,
  type FixtureSnapshot,
} from "./db";

/**
 * Runs once, in the runner process, after every worker has finished.
 *
 * WHY THE FIXTURE GUARD LIVES HERE AND NOT IN A TEST. It used to be the last
 * `test()` in user-lifecycle.spec.ts, captioned "the five seeded fixture
 * accounts are untouched" and described as a guard that runs after the
 * mutating tests. Under `fullyParallel: true` that was not true: Playwright
 * distributes tests across workers, so the guard could be -- and routinely was
 * -- scheduled BEFORE or DURING the tests whose damage it was supposed to
 * catch. A guard that can run first is not a guard.
 *
 * A global teardown genuinely runs last, and it runs even when a worker was
 * killed by a hard timeout, which is exactly when the sweep below matters most.
 *
 * It is also now a DIFF rather than a restatement. global-setup.ts records what
 * the five accounts looked like before the run; this compares against that
 * baseline, so a demotion, a revocation bump or a password rotation is caught,
 * not just the three flags the old assertion happened to name.
 *
 * A throw here fails the run. That is intended: the seeded accounts are what
 * three other specs log in as, so a run that damaged one has produced results
 * nobody should trust, however green the individual tests looked.
 */

function describeDiff(
  email: string,
  before: FixtureSnapshot[string],
  after: FixtureSnapshot[string] | undefined,
): string | null {
  if (!after) {
    return `${email}: the row is GONE. It existed before this run.`;
  }

  const fields: (keyof FixtureSnapshot[string])[] = [
    "role",
    "isActive",
    "mustChangePassword",
    "tokenVersion",
    "hasPassword",
  ];

  const changed = fields
    .filter((field) => before[field] !== after[field])
    .map((field) => `${field}: ${String(before[field])} -> ${String(after[field])}`);

  return changed.length > 0 ? `${email}: ${changed.join(", ")}` : null;
}

export default async function globalTeardown(): Promise<void> {
  const problems: string[] = [];
  let comparedAgainstBaseline = false;

  try {
    const swept = await sweepE2eAccounts();
    if (swept > 0) {
      console.warn(
        `[e2e] global teardown swept ${swept} account(s) matching ${E2E_EMAIL_LIKE} ` +
          "that a spec's own afterAll did not remove (a crashed or timed-out worker).",
      );
    }

    const after = await readFixtureSnapshot();

    for (const { email, role } of SEEDED_FIXTURES) {
      const row = after[email];
      if (!row) {
        problems.push(`${email}: seeded fixture is missing from the database.`);
        continue;
      }
      // Absolute invariants, checked whether or not a baseline exists: these
      // are the properties the other three specs depend on to log in at all.
      if (!row.isActive) problems.push(`${email}: seeded fixture is deactivated.`);
      if (row.mustChangePassword) {
        problems.push(`${email}: seeded fixture is flagged for a password change.`);
      }
      if (!row.hasPassword) problems.push(`${email}: seeded fixture has no password.`);
      if (row.role !== role) {
        problems.push(`${email}: seeded fixture role is "${row.role}", expected "${role}".`);
      }
    }

    if (existsSync(FIXTURE_SNAPSHOT_PATH)) {
      const before = JSON.parse(
        readFileSync(FIXTURE_SNAPSHOT_PATH, "utf8"),
      ) as FixtureSnapshot;

      for (const [email, beforeRow] of Object.entries(before)) {
        const diff = describeDiff(email, beforeRow, after[email]);
        if (diff) problems.push(diff);
      }
      rmSync(FIXTURE_SNAPSHOT_PATH, { force: true });
      comparedAgainstBaseline = true;
    } else {
      console.warn(
        "[e2e] no pre-run fixture baseline found; only the absolute invariants were checked.",
      );
    }
  } finally {
    await disconnectPrisma();
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "E2E global teardown: the seeded fixture accounts were NOT left as found.",
        "",
        ...problems.map((problem) => `  - ${problem}`),
        "",
        "These five accounts are shared: tickets.spec.ts, sla-tracking.spec.ts and",
        "time-entry-to-invoice.spec.ts all sign in as them, concurrently with this",
        "suite. Whatever mutated one of them has invalidated this whole run, and the",
        "resulting failures would otherwise surface in a spec with nothing to do with",
        "the cause. Re-run `npm run db:seed` before trusting another run.",
      ].join("\n"),
    );
  }

  console.log(
    comparedAgainstBaseline
      ? "[e2e] seeded fixture accounts verified unchanged against the pre-run baseline."
      : "[e2e] seeded fixture accounts pass their absolute invariants (no baseline to diff against).",
  );
}
