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
 * THIS FILE IS THE INTERACTIVE SHELL ONLY. Argv parsing, the TTY gate,
 * prompting, echo suppression, printing and the process exit code live here.
 * Every decision that writes to the database -- normalization, the password
 * floor, the refusals, the explicit role, the read-back -- lives in
 * src/lib/bootstrap-admin.ts, which takes already-collected values and a
 * PrismaClient and returns a result.
 *
 * The split exists because of the TTY gate below: no test runner can drive a
 * hidden prompt, so as one file this -- the only path to a production account
 * -- was unreachable from any automated test, and its only evidence was a
 * hand-driven transcript. The logic module is now reachable; this shell is
 * still not, by design.
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
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";

import { MIN_PASSWORD_LENGTH } from "../src/lib/validations/user";
import {
  createBootstrapAdmin,
  explainPrismaFailure,
  existingAccountMessage,
  findBootstrapAccount,
  isResetConfirmed,
  missingAccountMessage,
  normalizeBootstrapEmail,
  notAdminMessage,
  resetBootstrapAdminPassword,
  resolveDatabaseUrl,
  RESET_ABORTED_MESSAGE,
  validateBootstrapPassword,
  type BootstrapAccount,
  type BootstrapResult,
} from "../src/lib/bootstrap-admin";

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
 * The floor is checked with validateBootstrapPassword so the prompt and the
 * write agree on one rule; the write re-checks it regardless, because that is
 * the check a test can reach.
 */
async function askNewPassword(): Promise<string> {
  for (;;) {
    const password = await askSecret(`Password (hidden, min ${MIN_PASSWORD_LENGTH} chars): `);

    const check = validateBootstrapPassword(password);
    if (!check.ok) {
      console.error(`  ${check.message} Try again.`);
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
 * Normalization and validation are delegated to normalizeBootstrapEmail, which
 * runs createUserSchema's email field: the same schema /admin/users uses, so a
 * bootstrap admin cannot be created in a shape the UI would have rejected.
 */
async function resolveEmail(fromArgv: string | undefined): Promise<string> {
  let candidate = fromArgv;

  for (;;) {
    const raw = candidate ?? (await ask("Admin email: "));
    const normalized = normalizeBootstrapEmail(raw);

    if (normalized.ok) {
      return normalized.email;
    }

    console.error(`  ${normalized.message}.`);
    candidate = undefined;
  }
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
  //
  // This is also why src/lib/bootstrap-admin.ts exists: everything past this
  // gate used to be untestable by construction.
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

  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl.ok) {
    console.error(databaseUrl.message);
    return 1;
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl.url });
  const db = new PrismaClient({ adapter });

  try {
    const email = await resolveEmail(positional[0]);
    const existing = await findBootstrapAccount(db, email);

    if (resetPassword) {
      return await runReset(db, email, existing);
    }

    return await runCreate(db, email, existing);
  } catch (error) {
    console.error(explainPrismaFailure(error));
    return 1;
  } finally {
    await db.$disconnect();
  }
}

/** Prints a written row the way the operator needs to read it back. */
function printRow(row: Extract<BootstrapResult, { ok: true }>["user"]): void {
  console.log(`  id                 ${row.id}`);
  console.log(`  email              ${row.email}`);
  console.log(`  name               ${row.name ?? "(none)"}`);
  console.log(`  role               ${row.role}`);
  console.log(`  isActive           ${row.isActive}`);
  console.log(`  mustChangePassword ${row.mustChangePassword}`);
}

async function runCreate(
  db: PrismaClient,
  email: string,
  existing: BootstrapAccount | null,
): Promise<number> {
  // Checked here so the operator is not asked for a display name and a
  // password that would then be discarded. createBootstrapAdmin refuses the
  // same case itself (and again on P2002, if a concurrent create wins the race
  // between this lookup and the insert), so this is UX, not the guard.
  if (existing) {
    console.error(existingAccountMessage(email));
    return 1;
  }

  const name = (await ask("Display name: ")) || email.split("@")[0];
  const password = await askNewPassword();

  const result = await createBootstrapAdmin(db, { name, email, password });

  if (!result.ok) {
    // The read-back row is printed first when there is one: on a role
    // mismatch, what was actually written is the thing the operator needs.
    if (result.user) {
      console.log("\nWrote this row (read back from the database):\n");
      printRow(result.user);
      console.log("");
    }
    console.error(result.message);
    return 1;
  }

  // Read back from the database rather than echoing what we asked for: this is
  // the proof the operator gets that they hold an ADMIN and not a technician.
  console.log("\nCreated admin account (read back from the database):\n");
  printRow(result.user);

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
 * back before anything is written. Every one of those refusals is re-checked
 * inside resetBootstrapAdminPassword; what happens here is the prompting.
 */
async function runReset(
  db: PrismaClient,
  email: string,
  existing: BootstrapAccount | null,
): Promise<number> {
  // Refused here so the operator is not made to type a confirmation and a new
  // password against an account that was never going to be written.
  // resetBootstrapAdminPassword refuses both cases itself.
  if (!existing) {
    console.error(missingAccountMessage(email));
    return 1;
  }

  if (existing.role !== "admin") {
    console.error(notAdminMessage(email, existing.role));
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

  const confirmation = await ask("\nType the account email to confirm (or anything else to abort): ");

  // Checked here so a wrong answer aborts BEFORE the operator is made to type
  // a new password twice into a hidden prompt. Same predicate the write uses.
  if (!isResetConfirmed(existing.email, confirmation)) {
    console.error(RESET_ABORTED_MESSAGE);
    return 1;
  }

  const password = await askNewPassword();

  const result = await resetBootstrapAdminPassword(db, { email, password, confirmation });

  if (!result.ok) {
    console.error(result.message);
    return 1;
  }

  console.log("\nPassword reset (row read back from the database):\n");
  console.log(`  id                 ${result.user.id}`);
  console.log(`  email              ${result.user.email}`);
  console.log(`  role               ${result.user.role}`);
  console.log(`  isActive           ${result.user.isActive}`);
  console.log(`  mustChangePassword ${result.user.mustChangePassword}`);

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(explainPrismaFailure(error));
    process.exitCode = 1;
  })
  .finally(() => {
    muted = false;
    rl.close();
  });
