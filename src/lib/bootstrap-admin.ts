import type { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

import { createUserSchema, MIN_PASSWORD_LENGTH } from "@/lib/validations/user";

/**
 * The first-admin bootstrap LOGIC, split out of scripts/create-admin.ts.
 *
 * WHY THIS FILE EXISTS. The script is gated on `process.stdin.isTTY` (the
 * password is read from a prompt with echo suppressed and is never accepted
 * from argv, a pipe or the environment), so no test runner can ever drive it.
 * It is also the only path to a production account, which left the single
 * most consequential write in the system with no automated coverage at all --
 * its own summary flagged that a refactor of the echo-muting could silently
 * un-suppress the password echo with nothing to catch it.
 *
 * Everything here takes ALREADY-COLLECTED values and an already-constructed
 * PrismaClient, and returns a result instead of printing or exiting. Prompting,
 * echo suppression, TTY detection, argv parsing and process exit codes stay in
 * the script. That is the whole split: the logic is reachable from a test, the
 * interactive shell is not.
 *
 * NOTHING IN THIS MODULE READS process.stdin, WRITES TO stdout, OR CALLS
 * process.exit. Keep it that way -- the moment it does, it stops being
 * testable and this split has bought nothing.
 *
 * It also does not import src/lib/db.ts. That module memoizes a client on
 * globalThis for the Next dev server's module-reload lifecycle; a one-shot
 * script and a test each want their own client, so the client is a parameter.
 */

/**
 * bcrypt cost 10, matching prisma/seed.ts, src/lib/actions/users.ts and the
 * /change-password action. A hash written here at a different cost would still
 * verify (the cost is encoded in the hash), but keeping one number across the
 * codebase means there is one number to raise later.
 */
export const BOOTSTRAP_BCRYPT_COST = 10;

/** The row shape read back from the database after a write, and returned. */
export type BootstrapAdminRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
  tokenVersion: number;
};

/** The pre-existing account a bootstrap run may find at the target email. */
export type BootstrapAccount = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
};

export type BootstrapErrorCode =
  /** name/email/role failed createUserSchema. */
  | "invalid_input"
  /** Below MIN_PASSWORD_LENGTH. */
  | "password_too_short"
  /** Create refused: an account already holds this email. */
  | "already_exists"
  /** Reset refused: no account holds this email. */
  | "not_found"
  /** Reset refused: the account exists but is not an admin. */
  | "not_admin"
  /** Reset refused: the operator did not type the account's email back. */
  | "not_confirmed"
  /** The row was written but read back with a role other than "admin". */
  | "role_verification_failed";

export type BootstrapResult =
  | { ok: true; user: BootstrapAdminRow }
  | {
      ok: false;
      code: BootstrapErrorCode;
      message: string;
      /**
       * Present only for "role_verification_failed": the row that WAS written,
       * so the caller can show the operator what it actually got.
       */
      user?: BootstrapAdminRow;
    };

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Resolves DATABASE_URL, explicitly and early.
 *
 * Nothing loads dotenv for a bare `tsx` run on this project: prisma/seed.ts
 * gets DATABASE_URL because `prisma db seed` loads prisma7.config.ts (which
 * imports dotenv/config), and the poller gets it from docker-compose. Left
 * unchecked, the operator's very first command on a fresh host would fail
 * inside the pg driver with an opaque undefined-connection-string error.
 *
 * Returns the message rather than printing and exiting, so the wording is
 * assertable and the environment is a parameter rather than a global read.
 */
export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; url: string } | { ok: false; message: string } {
  const url = env.DATABASE_URL;

  if (!url || url.trim().length === 0) {
    return {
      ok: false,
      message: [
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
    };
  }

  return { ok: true, url };
}

/** Duck-typed rather than `instanceof Prisma.PrismaClientKnownRequestError` so
 *  the check does not depend on which module path the error class is exported
 *  from in a given Prisma major. */
export function prismaErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Turns a thrown Prisma error into an actionable operator message.
 *
 * P2022 (an expected column is missing) is the one that matters most: it means
 * the migration has not been applied, and the running app is in the same state
 * -- every login reports "Invalid email or password", including for admins.
 */
export function explainPrismaFailure(error: unknown): string {
  const code = prismaErrorCode(error);

  if (code === "P2022") {
    return [
      "The database is missing a column this application expects (Prisma P2022).",
      "",
      "The migration adding User.isActive and User.mustChangePassword has not been",
      "applied to this database. Apply it first, then re-run this command:",
      "",
      "  npm run db:migrate:deploy",
      "",
      "Note that the running app is in the same state: until that migration is applied,",
      'every login reports "Invalid email or password", including for admins.',
    ].join("\n");
  }

  if (code === "P1001" || code === "P1000") {
    return [
      `Could not connect to the database (Prisma ${code}).`,
      "",
      "Check that the db service is up (`docker compose ps`) and that DATABASE_URL",
      "points at the published host port from your .env (DB_PORT), not at db:5432,",
      "which only resolves inside the Docker network.",
    ].join("\n");
  }

  return `Bootstrap failed: ${String(error)}`;
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes and validates an operator-supplied email.
 *
 * Delegated to createUserSchema, the same schema /admin/users uses, so a
 * bootstrap admin cannot be created in a shape the UI would have rejected. Its
 * `.toLowerCase()` transform is what makes the account reachable at all:
 * authorize() looks users up with `email.toLowerCase()` (src/auth.ts), so a
 * stored address carrying any uppercase character can never be logged into,
 * and fails with the same anti-enumeration "Invalid email or password" a wrong
 * password produces.
 */
export function normalizeBootstrapEmail(
  raw: string,
): { ok: true; email: string } | { ok: false; message: string } {
  const parsed = createUserSchema.shape.email.safeParse(raw);

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Enter a valid email address",
    };
  }

  return { ok: true, email: parsed.data };
}

/**
 * The password floor, enforced HERE and not only at the prompt.
 *
 * MIN_PASSWORD_LENGTH comes from src/lib/validations/user.ts rather than being
 * restated. Without this floor the one account that matters most -- the
 * production admin, created by the only documented bootstrap path -- would be
 * the single account in the system with no minimum length, while every account
 * created through /admin/users has one.
 *
 * The value is returned untrimmed by callers on purpose: leading or trailing
 * whitespace is a legitimate part of a password, so length is measured on
 * exactly what was typed.
 */
export function validateBootstrapPassword(
  password: string,
): { ok: true } | { ok: false; code: "password_too_short"; message: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: "password_too_short",
      message: `Too short: ${password.length} character(s), minimum is ${MIN_PASSWORD_LENGTH}.`,
    };
  }

  return { ok: true };
}

/**
 * The break-glass confirmation rule: the operator must type the TARGET
 * ACCOUNT'S email back before a password is overwritten.
 *
 * Exported so the script can abort before prompting for a password, and
 * re-checked inside resetBootstrapAdminPassword so the rule cannot be skipped
 * by calling that function directly. One definition, two call sites.
 */
export function isResetConfirmed(accountEmail: string, typed: string): boolean {
  return typed.trim().toLowerCase() === accountEmail;
}

/** Shown when the confirmation does not match. One wording, two call sites. */
export const RESET_ABORTED_MESSAGE = "Aborted. Nothing was written.";

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

const ACCOUNT_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
} as const;

const ROW_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  tokenVersion: true,
} as const;

/**
 * Looks up whatever account currently holds `email` (any role), or null.
 *
 * Lowercased and trimmed before the lookup, exactly as authorize() does
 * (src/auth.ts) and exactly as createUserSchema stores it. A caller that
 * passed a raw operator-typed address would otherwise miss an existing row and
 * be told the email is free.
 */
export async function findBootstrapAccount(
  db: PrismaClient,
  email: string,
): Promise<BootstrapAccount | null> {
  return db.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: ACCOUNT_SELECT,
  });
}

/**
 * Creates the first admin.
 *
 * Refuses an email that is already taken rather than overwriting it, and
 * refuses it again on P2002 if a concurrent create won the race between the
 * lookup and the insert.
 *
 * The row is READ BACK after the write and its role verified. That is the
 * proof the operator gets that they hold an admin and not a technician --
 * Prisma's User.role defaults to `technician` (prisma/schema.prisma), so a
 * dropped `role: "admin"` here would silently produce an account with no Admin
 * nav and no way to create anyone else, on a deployment where the seed-based
 * fallback has just been retired.
 */
export async function createBootstrapAdmin(
  db: PrismaClient,
  input: { name: string; email: string; password: string },
): Promise<BootstrapResult> {
  const parsed = createUserSchema.safeParse({
    name: input.name,
    email: input.email,
    // EXPLICIT, and not a caller parameter: this function creates admins. The
    // schema validates it, and the read-back below re-checks the stored value.
    role: "admin",
  });

  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_input",
      message: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const passwordCheck = validateBootstrapPassword(input.password);
  if (!passwordCheck.ok) {
    return { ok: false, code: passwordCheck.code, message: passwordCheck.message };
  }

  const existing = await findBootstrapAccount(db, parsed.data.email);
  if (existing) {
    return {
      ok: false,
      code: "already_exists",
      message: existingAccountMessage(parsed.data.email),
    };
  }

  const hashedPassword = await hash(input.password, BOOTSTRAP_BCRYPT_COST);

  let created: { id: string };
  try {
    created = await db.user.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        hashedPassword,
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
      return {
        ok: false,
        code: "already_exists",
        message: `An account already exists for ${parsed.data.email}. Nothing was written.`,
      };
    }
    throw error;
  }

  const user = await db.user.findUniqueOrThrow({
    where: { id: created.id },
    select: ROW_SELECT,
  });

  if (user.role !== "admin") {
    return {
      ok: false,
      code: "role_verification_failed",
      message: `The created account has role "${user.role}", not "admin". Do not proceed.`,
      user,
    };
  }

  return { ok: true, user };
}

/**
 * The refusal shown when create finds the email taken. Exported because the
 * script needs it BEFORE it calls createBootstrapAdmin -- it must not prompt
 * for a display name and a password only to throw them away -- and one wording
 * for one refusal is the point of extracting this module at all.
 */
export function existingAccountMessage(email: string): string {
  return [
    `An account already exists for ${email}. Nothing was written.`,
    "",
    "This script will not silently overwrite an account. If you are locked out of",
    "this admin and need to set a new password, use the explicit break-glass path:",
    "",
    `  npm run bootstrap:admin -- --reset-password ${email}`,
  ].join("\n");
}

/**
 * The two reset refusals that depend only on the account, not on the password.
 *
 * Exported for the same reason existingAccountMessage is: the script has to
 * refuse BEFORE it prompts for a confirmation and a password it would then
 * discard, and one refusal should have one wording.
 * resetBootstrapAdminPassword re-checks both conditions itself, so skipping
 * these in a caller cannot cause a write.
 */
export function missingAccountMessage(email: string): string {
  return [
    `No account exists for ${email}. Nothing was written.`,
    "",
    "To create it instead, run without the flag:",
    "",
    `  npm run bootstrap:admin -- ${email}`,
  ].join("\n");
}

export function notAdminMessage(email: string, role: string): string {
  return [
    `${email} has role "${role}", not "admin". Nothing was written.`,
    "",
    "This flag is the break-glass path for a locked-out ADMIN. A non-admin's",
    "password is reset by an admin from /admin/users, which generates a temporary",
    "password and forces a change on next login.",
  ].join("\n");
}

/**
 * Break-glass password reset for an EXISTING admin.
 *
 * This exists because there is otherwise NO recovery path for a locked-out
 * sole admin: resetUserPassword requires an admin session to call, self-serve
 * reset is out of scope for this phase, and the seed is retired as the
 * documented path -- which would leave hand-written SQL as the only option,
 * the exact thing this work removes.
 *
 * Every refusal is re-checked here rather than trusted from the caller: the
 * account must exist, must be an admin, and `confirmation` must be the
 * account's own email typed back. It deliberately does NOT flip `isActive`:
 * reactivating an offboarded account is a decision, not a side effect.
 *
 * `tokenVersion` is incremented in the same write. Break-glass recovery is
 * used precisely when an account may be compromised, so it must evict every
 * session already issued for it -- rotating the hash alone does not, because a
 * JWT is self-contained. getCurrentUser() refuses any token whose stamped
 * tokenVersion differs from this column. Same increment resetUserPassword
 * performs.
 */
export async function resetBootstrapAdminPassword(
  db: PrismaClient,
  input: { email: string; password: string; confirmation: string },
): Promise<BootstrapResult> {
  const normalized = normalizeBootstrapEmail(input.email);
  if (!normalized.ok) {
    return { ok: false, code: "invalid_input", message: normalized.message };
  }

  const existing = await findBootstrapAccount(db, normalized.email);

  if (!existing) {
    return { ok: false, code: "not_found", message: missingAccountMessage(normalized.email) };
  }

  if (existing.role !== "admin") {
    return {
      ok: false,
      code: "not_admin",
      message: notAdminMessage(normalized.email, existing.role),
    };
  }

  if (!isResetConfirmed(existing.email, input.confirmation)) {
    return { ok: false, code: "not_confirmed", message: RESET_ABORTED_MESSAGE };
  }

  const passwordCheck = validateBootstrapPassword(input.password);
  if (!passwordCheck.ok) {
    return { ok: false, code: passwordCheck.code, message: passwordCheck.message };
  }

  const hashedPassword = await hash(input.password, BOOTSTRAP_BCRYPT_COST);

  await db.user.update({
    where: { id: existing.id },
    data: {
      hashedPassword,
      // The operator chose this password at a hidden prompt, and an admin
      // recovering an account mid-outage should land on the dashboard, not be
      // bounced straight into /change-password.
      mustChangePassword: false,
      tokenVersion: { increment: 1 },
    },
  });

  const user = await db.user.findUniqueOrThrow({
    where: { id: existing.id },
    select: ROW_SELECT,
  });

  return { ok: true, user };
}
