import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

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

let client: PrismaClient | null = null;

/** Lazily-constructed Prisma client for the runner process. */
export function prisma(): PrismaClient {
  client ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: envValue("DATABASE_URL") }),
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

/** The five seeded fixture accounts, as prisma/seed.ts writes them. */
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

/** Where the pre-run fixture baseline is parked between the two global hooks. */
export const FIXTURE_SNAPSHOT_PATH = path.join(
  process.env.TMPDIR ?? "/tmp",
  "dean-psa-e2e-fixture-snapshot.json",
);
