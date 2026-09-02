/**
 * First-admin bootstrap for a fresh deployment.
 *
 *   npm run bootstrap:admin                        # prompts for everything
 *   npm run bootstrap:admin -- admin@yourmsp.com   # email from argv, password prompted
 *   npm run bootstrap:admin -- --reset-password [email]   # break-glass recovery
 *
 * This is the documented path to the first real account. It replaces the
 * previous guidance in DEPLOYMENT.md ("run prisma/seed.ts with
 * ALLOW_SEED_IN_PRODUCTION=true, or insert a User row by hand"). The seed's
 * guard rail stays exactly as it is -- it is simply no longer the documented
 * way to create a production admin.
 *
 * SECURITY -- the password is NEVER read from argv or from the environment.
 * `npm run bootstrap:admin -- email hunter2` would write the production admin
 * password into shell history and expose it in `ps` output for every local
 * user for the lifetime of the process. It is read only from an interactive
 * prompt with terminal echo suppressed, and is never printed, logged, or
 * included in an error message.
 *
 * Runs as a plain `tsx` process outside Next.js (like scripts/email-poller.ts),
 * so it constructs its own PrismaClient with PrismaPg exactly as prisma/seed.ts
 * does rather than importing src/lib/db.ts -- that module memoizes a client on
 * globalThis for the Next dev-server's module-reload lifecycle, which a
 * one-shot script neither needs nor should participate in.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hash } from "bcryptjs";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";

import { createUserSchema, MIN_PASSWORD_LENGTH } from "../src/lib/validations/user";

/**
 * bcrypt cost 10, matching prisma/seed.ts, src/lib/actions/users.ts and the
 * /change-password action. A hash written here at a different cost would still
 * verify (the cost is encoded in the hash), but keeping one number across the
 * codebase means there is one number to raise later.
 */
const BCRYPT_COST = 10;

// ---------------------------------------------------------------------------
// Interactive input
// ---------------------------------------------------------------------------

/**
 * Echo suppression, using only `node:readline/promises` and `node:stream` --
 * no new dependency, and no reach into readline's private `_writeToOutput`.
 *
 * The interface is given a Writable of our own instead of process.stdout. In
 * terminal mode readline echoes every keystroke by writing it to `output`, so
 * dropping writes while `muted` is set drops the echo. `rl.question()` writes
 * its prompt synchronously before returning the promise, which is why the
 * prompt itself is visible even though the answer that follows is not.
 */
let muted = false;

const gatedOutput = new Writable({
  write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  },
});

// readline reads `output.columns` to wrap and redraw the current line.
Object.defineProperty(gatedOutput, "columns", {
  get: () => process.stdout.columns,
});

const rl = readline.createInterface({
  input: process.stdin,
  output: gatedOutput,
  terminal: true,
});

async function ask(query: string): Promise<string> {
  return (await rl.question(query)).trim();
}

/**
 * Reads a secret with echo suppressed. The trailing newline the user typed is
 * swallowed along with the echo, so it is re-emitted by hand to keep the
 * transcript readable. The value is returned untrimmed -- leading or trailing
 * whitespace is a legitimate part of a password.
 */
async function askSecret(query: string): Promise<string> {
  const pending = rl.question(query);
  muted = true;
  try {
    return await pending;
  } finally {
    muted = false;
    process.stdout.write("\n");
  }
}

/**
 * Prompts for a password twice and returns it only when both entries match and
 * clear MIN_PASSWORD_LENGTH. Re-prompts rather than exiting: an operator who
 * mistypes a password into a hidden prompt at 2am during a lockout should get
 * another try, not a non-zero exit and a re-read of the runbook.
 *
 * MIN_PASSWORD_LENGTH is imported from src/lib/validations/user.ts rather than
 * restated. Without this floor the one account that matters most -- the
 * production admin, created by the only documented bootstrap path -- would be
 * the single account in the system with no minimum length, while every account
 * created through /admin/users has one.
 */
async function askNewPassword(): Promise<string> {
  for (;;) {
    const password = await askSecret("Password (hidden, min " + MIN_PASSWORD_LENGTH + " chars): ");

    if (password.length < MIN_PASSWORD_LENGTH) {
      console.error(
        `  Too short: ${password.length} character(s), minimum is ${MIN_PASSWORD_LENGTH}. Try again.`,
      );
      continue;
    }

    // Confirmed because the entry was invisible: a typo here is an account
    // nobody can log into, discovered only at the login screen.
    const confirmation = await askSecret("Confirm password (hidden): ");

    if (password !== confirmation) {
      console.error("  Passwords do not match. Try again.");
      continue;
    }

    return password;
  }
}

/**
 * Email is the one field that may come from argv -- it is not a secret, and
 * putting it on the command line keeps the documented invocation short.
 * Normalization and validation are delegated to createUserSchema, the same
 * schema /admin/users uses, so a bootstrap admin cannot be created in a shape
 * the UI would have rejected. Its `.toLowerCase()` transform is what makes the
 * account reachable at all: authorize() looks users up with
 * `email.toLowerCase()` (src/auth.ts:51), so a stored address carrying any
 * uppercase character can never be logged into, and fails with the same
 * anti-enumeration "Invalid email or password" a wrong password produces.
 */
async function resolveEmail(fromArgv: string | undefined): Promise<string> {
  let candidate = fromArgv;

  for (;;) {
    const raw = candidate ?? (await ask("Admin email: "));
    const normalized = raw.trim().toLowerCase();
    const parsed = createUserSchema.shape.email.safeParse(normalized);

    if (parsed.success) {
      return parsed.data;
    }

    console.error(`  ${parsed.error.issues[0]?.message ?? "Enter a valid email address"}.`);
    candidate = undefined;
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Resolved explicitly, and early.
 *
 * Nothing loads dotenv for a bare `tsx` run on this project: prisma/seed.ts
 * gets DATABASE_URL because `prisma db seed` loads prisma7.config.ts (which
 * imports dotenv/config), and the poller gets it from docker-compose. Left
 * unchecked, the operator's very first command on a fresh host would fail
 * inside the pg driver with an opaque undefined-connection-string error.
 */
function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (!url || url.trim().length === 0) {
    console.error(
      [
        "DATABASE_URL is not set.",
        "",
        "This script runs as a plain node process and does not load .env by itself.",
        "Export the value already in your .env file into the shell first:",
        "",
        "  set -a; . ./.env; set +a",
        "  npm run bootstrap:admin",
        "",
        "(Prefer that over prefixing the command with DATABASE_URL=... -- the connection",
        "string contains the database password and would land in your shell history.)",
        "",
        "It must point at the same database `npm run db:migrate:deploy` was run against.",
      ].join("\n"),
    );
    process.exit(1);
  }

  return url;
}

/** Duck-typed rather than `instanceof Prisma.PrismaClientKnownRequestError` so
 *  the check does not depend on which module path the error class is exported
 *  from in a given Prisma major. */
function prismaErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function explainPrismaFailure(error: unknown): void {
  const code = prismaErrorCode(error);

  if (code === "P2022") {
    console.error(
      [
        "The database is missing a column this application expects (Prisma P2022).",
        "",
        "The migration adding User.isActive and User.mustChangePassword has not been",
        "applied to this database. Apply it first, then re-run this command:",
        "",
        "  npm run db:migrate:deploy",
        "",
        "Note that the running app is in the same state: until that migration is applied,",
        'every login reports "Invalid email or password", including for admins.',
      ].join("\n"),
    );
    return;
  }

  if (code === "P1001" || code === "P1000") {
    console.error(
      [
        `Could not connect to the database (Prisma ${code}).`,
        "",
        "Check that the db service is up (`docker compose ps`) and that DATABASE_URL",
        "points at the published host port from your .env (DB_PORT), not at db:5432,",
        "which only resolves inside the Docker network.",
      ].join("\n"),
    );
    return;
  }

  console.error("Bootstrap failed:", error);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = [
  "Usage:",
  "  npm run bootstrap:admin [-- <email>]",
  "  npm run bootstrap:admin -- --reset-password [<email>]",
  "",
  "Creates the first admin account for a fresh deployment. The password is never",
  "read from the command line or the environment -- only from a hidden prompt.",
  "",
  "  --reset-password   Break-glass: set a new password on an EXISTING admin.",
  "                     Requires typing the account's email to confirm.",
  "  --help             Show this message.",
].join("\n");

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  const resetPassword = argv.includes("--reset-password");
  const positional = argv.filter((arg) => !arg.startsWith("-"));

  if (positional.length > 1) {
    console.error("Too many arguments.\n");
    console.error(USAGE);
    console.error(
      "\nIf you were passing a password as the second argument: this script deliberately" +
        "\nrefuses to accept one there. It would land in your shell history and in `ps`.",
    );
    return 1;
  }

  const unknownFlags = argv.filter((arg) => arg.startsWith("-") && arg !== "--reset-password");
  if (unknownFlags.length > 0) {
    console.error(`Unknown option: ${unknownFlags[0]}\n`);
    console.error(USAGE);
    return 1;
  }

  // A hidden prompt cannot be satisfied by a pipe or a CI runner. Failing here
  // is the difference between a clear error and silently creating an admin
  // whose password is the empty string.
  if (!process.stdin.isTTY) {
    console.error(
      [
        "This script requires an interactive terminal: the password is read from a",
        "prompt with echo suppressed and is never accepted from argv, stdin redirection,",
        "or an environment variable.",
        "",
        "Run it from a shell on the host (or `docker compose exec -it app ...`).",
      ].join("\n"),
    );
    return 1;
  }

  const connectionString = requireDatabaseUrl();
  const adapter = new PrismaPg({ connectionString });
  const db = new PrismaClient({ adapter });

  try {
    const email = await resolveEmail(positional[0]);
    const existing = await db.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });

    if (resetPassword) {
      return await runReset(db, email, existing);
    }

    return await runCreate(db, email, existing !== null);
  } catch (error) {
    explainPrismaFailure(error);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

type ExistingUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
};

async function runCreate(
  db: PrismaClient,
  email: string,
  alreadyExists: boolean,
): Promise<number> {
  if (alreadyExists) {
    console.error(
      [
        `An account already exists for ${email}. Nothing was written.`,
        "",
        "This script will not silently overwrite an account. If you are locked out of",
        "this admin and need to set a new password, use the explicit break-glass path:",
        "",
        `  npm run bootstrap:admin -- --reset-password ${email}`,
      ].join("\n"),
    );
    return 1;
  }

  const name = (await ask("Display name: ")) || email.split("@")[0];
  const parsed = createUserSchema.safeParse({ name, email, role: "admin" });

  if (!parsed.success) {
    console.error(`  ${parsed.error.issues[0]?.message ?? "Invalid input"}.`);
    return 1;
  }

  const password = await askNewPassword();
  const hashedPassword = await hash(password, BCRYPT_COST);

  let created: { id: string };
  try {
    created = await db.user.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        hashedPassword,
        // EXPLICIT. Prisma's User.role defaults to `technician`
        // (prisma/schema.prisma:27), so omitting this line would make the
        // only documented bootstrap path silently produce a technician with
        // no Admin nav and no way to create anyone else -- on a deployment
        // where the previous seed-based fallback has just been retired.
        role: "admin",
        isActive: true,
        // The operator chose this password themselves at a hidden prompt, so
        // there is nothing to force them to change. (Accounts created later
        // from /admin/users get a generated temp password and DO carry this
        // flag.)
        mustChangePassword: false,
      },
      select: { id: true },
    });
  } catch (error) {
    // Lost a race with a concurrent create, or the unique index caught a
    // duplicate this run's earlier lookup did not see.
    if (prismaErrorCode(error) === "P2002") {
      console.error(`An account already exists for ${email}. Nothing was written.`);
      return 1;
    }
    throw error;
  }

  // Read the row back rather than echoing what we asked for: this is the proof
  // the operator gets that they hold an ADMIN and not a technician.
  const readBack = await db.user.findUniqueOrThrow({
    where: { id: created.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
    },
  });

  console.log("\nCreated admin account (read back from the database):\n");
  console.log(`  id                 ${readBack.id}`);
  console.log(`  email              ${readBack.email}`);
  console.log(`  name               ${readBack.name ?? "(none)"}`);
  console.log(`  role               ${readBack.role}`);
  console.log(`  isActive           ${readBack.isActive}`);
  console.log(`  mustChangePassword ${readBack.mustChangePassword}`);

  if (readBack.role !== "admin") {
    console.error(
      `\nThe created account has role "${readBack.role}", not "admin". Do not proceed.`,
    );
    return 1;
  }

  console.log(
    [
      "",
      "Log in at your AUTH_URL with this email and the password you just chose, then",
      "create the rest of the team from /admin/users. Do not do this over plaintext",
      "HTTP -- see DEPLOYMENT.md, 'Creating the first admin account'.",
    ].join("\n"),
  );

  return 0;
}

/**
 * Break-glass password reset. This exists because there is otherwise NO
 * recovery path for a locked-out sole admin: resetUserPassword requires an
 * admin session to call, self-serve reset is out of scope for this phase, and
 * the seed is being retired as the documented path -- which would leave hand-
 * written SQL as the only option, the exact thing this work removes.
 *
 * It is never the default and never silent: it takes an explicit flag, prints
 * the target account, and requires the operator to type that account's email
 * back before anything is written.
 */
async function runReset(
  db: PrismaClient,
  email: string,
  existing: ExistingUser | null,
): Promise<number> {
  if (!existing) {
    console.error(
      [
        `No account exists for ${email}. Nothing was written.`,
        "",
        "To create it instead, run without the flag:",
        "",
        `  npm run bootstrap:admin -- ${email}`,
      ].join("\n"),
    );
    return 1;
  }

  if (existing.role !== "admin") {
    console.error(
      [
        `${email} has role "${existing.role}", not "admin". Nothing was written.`,
        "",
        "This flag is the break-glass path for a locked-out ADMIN. A non-admin's",
        "password is reset by an admin from /admin/users, which generates a temporary",
        "password and forces a change on next login.",
      ].join("\n"),
    );
    return 1;
  }

  console.log("\nAbout to overwrite the password of this account:\n");
  console.log(`  id      ${existing.id}`);
  console.log(`  email   ${existing.email}`);
  console.log(`  name    ${existing.name ?? "(none)"}`);
  console.log(`  role    ${existing.role}`);
  console.log(`  active  ${existing.isActive}`);

  if (!existing.isActive) {
    console.log(
      [
        "",
        "WARNING: this account is DEACTIVATED. Resetting its password will not make it",
        "loginable -- authorize() rejects an inactive account before it ever compares a",
        "password, and reports the same \"Invalid email or password\". Reactivate it from",
        "/admin/users (as another admin) first. This flag deliberately does not flip",
        "isActive: reactivating an offboarded account is a decision, not a side effect.",
      ].join("\n"),
    );
  }

  const confirmation = await ask(`\nType the account email to confirm (or anything else to abort): `);

  if (confirmation.toLowerCase() !== existing.email) {
    console.error("Aborted. Nothing was written.");
    return 1;
  }

  const password = await askNewPassword();
  const hashedPassword = await hash(password, BCRYPT_COST);

  await db.user.update({
    where: { id: existing.id },
    data: {
      hashedPassword,
      // The operator chose this password at a hidden prompt, and an admin
      // recovering an account mid-outage should land on the dashboard, not be
      // bounced straight into /change-password.
      mustChangePassword: false,
    },
  });

  const readBack = await db.user.findUniqueOrThrow({
    where: { id: existing.id },
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
    },
  });

  console.log("\nPassword reset (row read back from the database):\n");
  console.log(`  id                 ${readBack.id}`);
  console.log(`  email              ${readBack.email}`);
  console.log(`  role               ${readBack.role}`);
  console.log(`  isActive           ${readBack.isActive}`);
  console.log(`  mustChangePassword ${readBack.mustChangePassword}`);

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    explainPrismaFailure(error);
    process.exitCode = 1;
  })
  .finally(() => {
    muted = false;
    rl.close();
  });
