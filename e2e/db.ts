import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { E2E_SERVER_IS_EXTERNAL } from "./target";

/**
 * Database access for the E2E suite: the specs, and the global setup/teardown
 * hooks that bracket them.
 *
 * This file is a helper module, not a spec -- it defines no `test`, so
 * Playwright's default testMatch never picks it up.
 */

/**
 * Reads a value from the environment, falling back to a hand-parsed `.env`.
 *
 * The Playwright runner process is not `next dev` and loads no dotenv of its
 * own, so `.env` is read here explicitly rather than assumed to be in the
 * environment. Parsed with a few lines rather than by pulling in `dotenv`,
 * which is present only transitively via Prisma and is not a declared
 * dependency of this project.
 */
export function envValue(name: string): string {
  const fromProcess = process.env[name];
  if (fromProcess) {
    return fromProcess;
  }

  const envPath = path.resolve(process.cwd(), ".env");
  const contents = readFileSync(envPath, "utf8");

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== name) continue;

    return line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }

  throw new Error(
    `${name} is not set and was not found in ${envPath}. ` +
      "The E2E suite needs it to read stored state back, decode the session token, " +
      "and tear down the accounts it creates.",
  );
}

/**
 * Every account any spec in this suite creates lives under this address shape.
 *
 * It is the contract between the specs (which create the rows), the per-run
 * teardown (which deletes the exact addresses it recorded) and the global
 * teardown (which sweeps by pattern for rows a crashed worker never got to).
 * `@e2e.invalid` is the RFC 2606 reserved TLD -- these addresses cannot be
 * routed and cannot collide with a real staff account.
 */
export const E2E_EMAIL_PREFIX = "e2e-lifecycle-";
export const E2E_EMAIL_DOMAIN = "@e2e.invalid";
export const E2E_EMAIL_LIKE = `${E2E_EMAIL_PREFIX}%${E2E_EMAIL_DOMAIN}`;

/**
 * The database this suite reads and writes -- and the coupling that makes it
 * NOT independent of which server the browser drives.
 *
 * E2E_BASE_URL retargets the SERVER (e2e/target.ts). It does not retarget this
 * process: DATABASE_URL is read from the runner's own environment or from the
 * `.env` in this working tree, so with E2E_BASE_URL pointed at a container or a
 * staging box the browser drives one system while every `readUserRow`, the
 * orphan sweep and the fixture baseline/diff hit another. Nothing in the
 * results would say so. Concretely that produces:
 *
 *   - assertions that read a row the server under test never wrote (a created
 *     user is "missing", a tokenVersion never moves);
 *   - a sweep and a per-spec teardown that delete accounts out of the LOCAL
 *     database while leaving the live ones on the target -- active accounts
 *     with known-shaped passwords, which is the exact hazard sweepE2eAccounts
 *     exists to remove;
 *   - a fixture diff that certifies the wrong five rows.
 *
 * So the second target is EXPLICIT rather than inferred: naming a foreign
 * server means naming its database too. There is nothing useful to guess --
 * the whole point of the E2E_BASE_URL hatch is that the caller knows something
 * this process cannot.
 *
 * AUTH_SECRET is coupled the same way and is deliberately NOT resolved here: it
 * is read through envValue() at its point of use, and a mismatch already
 * surfaces with its own message ("the session cookie must decode with
 * AUTH_SECRET"). Export it alongside E2E_DATABASE_URL when the foreign server
 * signs with a different secret.
 */
export const E2E_DATABASE_URL_ENV = "E2E_DATABASE_URL";

export function resolveE2eDatabaseUrl(): string {
  if (!E2E_SERVER_IS_EXTERNAL) {
    return envValue("DATABASE_URL");
  }

  const explicit = process.env[E2E_DATABASE_URL_ENV];
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }

  throw new Error(
    [
      "E2E_BASE_URL is set, so this run grades a server this process did not start --",
      `but ${E2E_DATABASE_URL_ENV} is not set, and this suite's database access would`,
      "fall back to DATABASE_URL from this working tree's .env.",
      "",
      "The browser would drive one system while every row read, the orphan sweep and",
      "the seeded-fixture baseline/diff hit another. Every database-backed assertion",
      "here would be reporting on the wrong database, and the sweep would delete local",
      "accounts while leaving live ones on the target.",
      "",
      `Fix: export ${E2E_DATABASE_URL_ENV} pointing at the database the server behind`,
      "E2E_BASE_URL actually uses (and AUTH_SECRET too, if it signs with a different",
      "secret). Unset E2E_BASE_URL to go back to the managed local server.",
    ].join("\n"),
  );
}

let client: PrismaClient | null = null;

/** Lazily-constructed Prisma client for the runner process. */
export function prisma(): PrismaClient {
  client ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: resolveE2eDatabaseUrl() }),
  });
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  await client?.$disconnect();
  client = null;
}

/**
 * Deletes every account this suite could have created, by pattern.
 *
 * THE CRASH BACKSTOP. Each spec deletes the exact addresses it recorded in its
 * own afterAll, which is precise and cannot touch another run's rows -- but a
 * hard worker timeout, a killed run or a machine that goes away never reaches
 * that hook. What it leaves behind is not litter: it is an ACTIVE account with
 * a known-shaped password on an instance served over plaintext HTTP, and in the
 * self-target and last-active-admin specs that account is an ADMIN. This sweep
 * runs at global setup (clearing anything a previous run orphaned, which is
 * also what keeps the last-active-admin precondition satisfiable) and again at
 * global teardown.
 *
 * The subjects own no tickets, comments or time entries -- they never do
 * anything but sign in -- so the delete has no foreign key to violate.
 *
 * KNOWN LIMIT, stated rather than hidden: this is a pattern sweep, so two
 * concurrent runs of this suite against the SAME database would delete each
 * other's subjects. The suite has never supported that (it shares one dev
 * database with the application), and the per-spec teardown remains
 * exact-address-keyed for exactly that reason.
 */
export async function sweepE2eAccounts(): Promise<number> {
  const { count } = await prisma().user.deleteMany({
    where: { email: { startsWith: E2E_EMAIL_PREFIX, endsWith: E2E_EMAIL_DOMAIN } },
  });
  return count;
}

/**
 * The five seeded fixture accounts, and the role prisma/seed.ts gives each.
 */
export const SEEDED_FIXTURES = [
  { email: "technician@mspdemo.local", role: "technician" },
  { email: "dispatcher@mspdemo.local", role: "dispatcher" },
  { email: "sales@mspdemo.local", role: "sales" },
  { email: "finance@mspdemo.local", role: "finance" },
  { email: "admin@mspdemo.local", role: "admin" },
] as const;

export type FixtureSnapshot = Record<
  string,
  {
    role: string;
    isActive: boolean;
    mustChangePassword: boolean;
    tokenVersion: number;
    hasPassword: boolean;
  }
>;

/**
 * Reads the five seeded fixtures' security-relevant state.
 *
 * Used to take a baseline before the run and to diff against it afterwards, so
 * "the fixtures were left as found" is a COMPARISON rather than a restatement
 * of what the seed is expected to have written. A run that demotes a fixture
 * and a seed that never set the role correctly look identical to a hardcoded
 * assertion; they do not look identical to a diff.
 */
export async function readFixtureSnapshot(): Promise<FixtureSnapshot> {
  const rows = await prisma().user.findMany({
    where: { email: { in: SEEDED_FIXTURES.map((fixture) => fixture.email) } },
    select: {
      email: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      tokenVersion: true,
      hashedPassword: true,
    },
  });

  const snapshot: FixtureSnapshot = {};
  for (const row of rows) {
    snapshot[row.email] = {
      role: row.role,
      isActive: row.isActive,
      mustChangePassword: row.mustChangePassword,
      tokenVersion: row.tokenVersion,
      hasPassword: row.hashedPassword !== null,
    };
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Entry drift: what the fixtures look like at setup vs. what the seed wrote
// ---------------------------------------------------------------------------

/**
 * What prisma/seed.ts's `create` block leaves behind, per fixture.
 *
 * WHY THIS EXISTS, given there is already a diff. The teardown diff's "before"
 * is whatever was in the database when this run started, so it proves THIS RUN
 * ADDED NO DAMAGE -- not that the fixtures are as seeded. Drift that was
 * already there at setup is copied into the baseline and then blessed by the
 * comparison, silently.
 *
 * That is not hypothetical. As this was written, admin@mspdemo.local sat at
 * `tokenVersion: 1` while the other four were at 0.
 *
 * THE DELIBERATE DECISION, and it is not "add another absolute invariant".
 * role/isActive/mustChangePassword/hasPassword have absolute invariants in
 * global-teardown.ts because their correct value never changes: a fixture that
 * is deactivated, flagged, password-less or demoted cannot be logged in as, and
 * three other specs log in as these accounts. `tokenVersion` has no such value.
 * It is a monotonic counter that a legitimate password change increments, so
 * "must be 0" would be WRONG -- it would fail a run for something the product
 * is supposed to do, and the natural way to make that failure go away is to
 * delete the check.
 *
 * So the values below are compared at SETUP and reported as ENTRY DRIFT: a
 * warning, naming the field and both values, and recorded into the baseline
 * file so the teardown's pass line can say what the "unchanged" was measured
 * against. It is a statement about the state the run inherited, which is
 * exactly what the diff cannot make -- and it is a warning rather than a
 * failure because entry drift is not this run's doing and cannot invalidate
 * this run's results. The four fields that DO have absolute invariants are
 * still hard-failed in global-teardown.ts.
 *
 * `tokenVersion: 0` here is the schema default (prisma/schema.prisma:
 * `tokenVersion Int @default(0)`), which is what the seed's `create` leaves
 * because it does not set the column; the other three are set explicitly by
 * that block, and `hasPassword` follows from its `hashedPassword`.
 */
export const SEEDED_FIXTURE_ENTRY_STATE = {
  isActive: true,
  mustChangePassword: false,
  hasPassword: true,
  tokenVersion: 0,
} as const;

/**
 * Compares a setup-time snapshot against the seeded values, one line per
 * divergence. An empty array means the run started from a pristine seed.
 */
export function describeEntryDrift(snapshot: FixtureSnapshot): string[] {
  const drift: string[] = [];

  for (const { email, role } of SEEDED_FIXTURES) {
    const row = snapshot[email];
    if (!row) {
      drift.push(`${email}: absent from the database at setup.`);
      continue;
    }

    const expected = { ...SEEDED_FIXTURE_ENTRY_STATE, role };
    for (const field of Object.keys(expected) as (keyof typeof expected)[]) {
      if (row[field] !== expected[field]) {
        drift.push(
          `${email}: ${field} is ${String(row[field])}, the seed leaves ${String(expected[field])}.`,
        );
      }
    }
  }

  return drift;
}

// ---------------------------------------------------------------------------
// Where the pre-run baseline is parked between the two global hooks
// ---------------------------------------------------------------------------

/**
 * The baseline file's path is passed from global setup to global teardown
 * through this variable. Both hooks run in the SAME runner process, so setting
 * it in setup is enough; nothing else reads it.
 */
export const FIXTURE_SNAPSHOT_PATH_ENV = "E2E_FIXTURE_SNAPSHOT_PATH";

/**
 * Creates a RUN-SCOPED path for the baseline and records it for the teardown.
 *
 * WHAT THIS REPLACES, and why the fixed path was a hole rather than a detail.
 * The baseline used to be written to one hardcoded name in $TMPDIR. The
 * teardown treated a MISSING file as "no baseline to diff against", logged a
 * console.warn and left the run green -- so the headline guarantee, a real
 * end-state diff of the five shared accounts, could be switched off without
 * failing anything by:
 *
 *   - `rm /tmp/dean-psa-e2e-fixture-snapshot.json` (observed live in review
 *     cycle 3: the diff was silently skipped and the run still passed);
 *   - a previous run that was killed after its teardown removed the file but
 *     before this run wrote it, or any other ordering accident;
 *   - a CONCURRENT run of this suite, whose teardown deletes the shared path
 *     and takes this run's baseline with it -- the same collision the sweep
 *     documents, on a second resource.
 *
 * Two changes close it, and both are needed: the path is now unique per run
 * (mkdtemp, so two runs cannot share or delete each other's file), and a
 * missing baseline is an ERROR in global-teardown.ts rather than a warning.
 * A unique path alone would still be skippable by deleting the file; an error
 * alone would turn a concurrent run into a spurious failure.
 */
export function createFixtureSnapshotPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dean-psa-e2e-"));
  const file = path.join(dir, "fixture-baseline.json");
  process.env[FIXTURE_SNAPSHOT_PATH_ENV] = file;
  return file;
}

/** The path global setup recorded, or null if it never got that far. */
export function recordedFixtureSnapshotPath(): string | null {
  return process.env[FIXTURE_SNAPSHOT_PATH_ENV] ?? null;
}

/** What global setup writes and global teardown reads back. */
export type FixtureBaseline = {
  recordedAt: string;
  /** Divergences from the seeded values that were ALREADY present at setup. */
  entryDrift: string[];
  snapshot: FixtureSnapshot;
};
