import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  E2E_EMAIL_LIKE,
  FIXTURE_SNAPSHOT_PATH_ENV,
  SEEDED_FIXTURES,
  disconnectPrisma,
  readFixtureSnapshot,
  recordedFixtureSnapshotPath,
  sweepE2eAccounts,
  type FixtureBaseline,
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
 * AND THE DIFF IS NOT OPTIONAL. A missing baseline is a FAILURE here, not a
 * console.warn on a green run: the baseline is written to a run-scoped path
 * (db.ts) that only this hook deletes, so if it is absent either setup never
 * completed or something removed it -- and in both cases the diff, which is the
 * strongest claim this suite makes about the shared accounts, did not happen.
 *
 * WHAT THE DIFF STILL CANNOT SEE, said plainly rather than implied: its "before"
 * is whatever was in the database at setup, so it proves this run added no
 * damage, NOT that the fixtures are as seeded. Drift already present at setup is
 * inside the baseline and compares equal. global-setup.ts reports that
 * separately as ENTRY DRIFT and records it in the baseline file, and the pass
 * line below repeats it, so a green run never reads as more than it is.
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
  /** Divergences from the seeded values that were already there at setup. */
  let inheritedDrift: string[] = [];

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

    // A MISSING BASELINE IS A FAILURE, NOT A WARNING. It used to downgrade to
    // console.warn on a fixed $TMPDIR path, which meant the headline guarantee
    // -- a real end-state diff of the five shared accounts -- could be turned
    // off by one `rm`, by a killed previous run, or by a concurrent run's
    // teardown, with the run still reporting green. Observed live in review
    // cycle 3. The path is run-scoped now (db.ts), so the remaining ways to
    // reach these branches are a setup that never completed or a file that was
    // deleted underneath us -- and in both cases this run produced no evidence
    // about the fixtures and must not say that it did.
    const baselinePath = recordedFixtureSnapshotPath();

    if (!baselinePath) {
      problems.push(
        `no pre-run fixture baseline was recorded (${FIXTURE_SNAPSHOT_PATH_ENV} is unset). ` +
          "Global setup did not reach its snapshot step, so it failed for its own reason -- " +
          "look above this message for that error. The end-state diff did not run.",
      );
    } else if (!existsSync(baselinePath)) {
      problems.push(
        `the pre-run fixture baseline recorded at ${baselinePath} is gone. It was written ` +
          "at setup and is deleted only here, so something removed it mid-run. The " +
          "end-state diff did not run and this run proves nothing about the five " +
          "seeded accounts.",
      );
    } else {
      let baseline: FixtureBaseline | null = null;
      try {
        baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as FixtureBaseline;
      } catch (cause) {
        problems.push(
          `the pre-run fixture baseline at ${baselinePath} could not be read back: ` +
            `${String(cause)}. The end-state diff did not run.`,
        );
      }

      if (baseline) {
        for (const [email, beforeRow] of Object.entries(baseline.snapshot)) {
          const diff = describeDiff(email, beforeRow, after[email]);
          if (diff) problems.push(diff);
        }
        inheritedDrift = baseline.entryDrift;
      }
    }

    if (baselinePath) {
      // The baseline lives in a per-run mkdtemp directory, so the directory
      // goes with it rather than accumulating one per run -- including on the
      // paths above that FAIL, where the file is already gone but the empty
      // directory would otherwise be left behind on every such run.
      rmSync(path.dirname(baselinePath), { recursive: true, force: true });
      delete process.env[FIXTURE_SNAPSHOT_PATH_ENV];
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

  // The pass line says what the baseline WAS, not just that nothing moved.
  // "Unchanged against the pre-run baseline" is a weaker claim than it reads
  // when the baseline itself diverged from the seed, and the reader of a green
  // run should not have to scroll back to setup to learn that.
  // Reaching here means the diff ran: every path that skips it pushes a
  // problem above and throws.
  console.log(
    inheritedDrift.length === 0
      ? "[e2e] seeded fixture accounts verified unchanged against the pre-run baseline, " +
          "which itself matched prisma/seed.ts exactly."
      : "[e2e] seeded fixture accounts verified unchanged against the pre-run baseline. " +
          `That baseline already carried ${inheritedDrift.length} divergence(s) from what ` +
          "prisma/seed.ts writes, so those were blessed, not verified: " +
          inheritedDrift.join(" "),
  );
}
