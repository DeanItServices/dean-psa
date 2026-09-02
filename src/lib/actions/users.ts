"use server";

import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { hash } from "bcryptjs";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { ADMIN_MANAGE_ROLES } from "@/lib/permissions";
import { createUserSchema, updateUserRoleSchema } from "@/lib/validations/user";

/**
 * User-lifecycle Server Actions: create, re-role, reset password, deactivate,
 * reactivate. Every export follows the established convention from
 * src/lib/actions/companies.ts -- requireRole() first, zod parse second,
 * Prisma write third, revalidatePath() last, errors returned as { error }.
 *
 * NOTHING HERE DELETES A USER ROW. Offboarding is `isActive: false`. Tickets,
 * ticket comments and time entries reference User and carry billing history;
 * deleting the row would either cascade that away or fail on a constraint.
 */

const USERS_PATH = "/admin/users";

/**
 * bcrypt cost factor. Matches prisma/seed.ts:39 exactly -- one hashing cost
 * for the whole application, so a password hashed by the seed, the bootstrap
 * script or this module is indistinguishable to `compare()` in authorize().
 */
const BCRYPT_COST = 10;

/**
 * Temporary-password alphabet: 32 symbols, deliberately excluding the
 * characters that get mis-transcribed when a value is read aloud or copied by
 * hand off a screen -- 0/O, 1/I/l -- and lowercase entirely.
 *
 * The length 32 is load-bearing for UNIFORMITY, not just readability: 256 is
 * an exact multiple of 32, so `byte % 32` maps every one of the 256 possible
 * byte values onto exactly 8 symbols with no residue. A 62-symbol
 * alphanumeric alphabet would make `byte % 62` favour the first 8 symbols by
 * ~3%, quietly shaving entropy off every password this module issues.
 */
const TEMP_PASSWORD_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * 20 symbols from a 32-symbol alphabet = 5 bits each = 100 bits of entropy,
 * far above the 12-character MIN_PASSWORD_LENGTH floor this value must also
 * clear (the recipient authenticates with it once before /change-password
 * forces them to replace it).
 */
const TEMP_PASSWORD_LENGTH = 20;

// Fail loudly at module load rather than silently biasing every password, in
// case a future edit changes the alphabet to a length that does not divide 256.
if (256 % TEMP_PASSWORD_ALPHABET.length !== 0) {
  throw new Error(
    "TEMP_PASSWORD_ALPHABET length must divide 256 evenly or `% length` introduces modulo bias",
  );
}

/**
 * Fixed key for the transaction-scoped advisory lock that serializes the
 * last-active-admin invariant. Arbitrary but stable: 7_03_03 reads as "phase
 * 07, plan 03". Every code path that could reduce the number of active admins
 * MUST take this same key, or it is not serialized against the others.
 */
const ADMIN_INVARIANT_LOCK_KEY = 7030303;

/**
 * Milliseconds a caller may wait for ADMIN_INVARIANT_LOCK_KEY before giving up.
 *
 * The critical section is one COUNT plus one UPDATE, so a wait longer than this
 * means something is wrong, not busy. Must stay comfortably BELOW the
 * `timeout` passed to $transaction below, so that contention surfaces as a
 * Postgres lock timeout this module recognises rather than as Prisma's opaque
 * transaction-API error.
 */
const ADMIN_LOCK_TIMEOUT_MS = 3_000;

/**
 * Generates a one-time temporary password.
 *
 * `randomBytes` (CSPRNG) and never `Math.random`, which is a seeded
 * non-cryptographic PRNG whose output is predictable from a handful of prior
 * values -- a credential generated from it is guessable.
 *
 * The return value is the ONLY place this string ever exists outside the
 * caller's screen. It is never logged, never put in an error message, and
 * never persisted: only its bcrypt hash reaches the database.
 */
function generateTempPassword(): string {
  const bytes = randomBytes(TEMP_PASSWORD_LENGTH);
  let password = "";

  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i += 1) {
    password += TEMP_PASSWORD_ALPHABET[bytes[i]! % TEMP_PASSWORD_ALPHABET.length];
  }

  return password;
}

/**
 * Structured, non-secret audit breadcrumb.
 *
 * 07-CONTEXT.md accepts that any admin may reset, demote or deactivate any
 * OTHER admin (admins are mutually trusted; a real audit log is deferred).
 * This line is the mitigation: the action is at least attributable to an
 * actor id after the fact.
 *
 * It records ids and an action name ONLY. No password material, no hash, no
 * email -- if this ever ships to a log aggregator, nothing in it is a secret.
 */
function logUserLifecycle(action: string, actorId: string, targetUserId: string) {
  console.info(
    JSON.stringify({
      event: "user_lifecycle",
      action,
      actorId,
      targetUserId,
      at: new Date().toISOString(),
    }),
  );
}

/**
 * Runs `body` inside a transaction that holds a Postgres transaction-scoped
 * advisory lock, making the read-then-write of the last-active-admin
 * invariant atomic with respect to every other holder of the same key.
 *
 * WHY THIS AND NOT A BARE `db.$transaction`:
 * Prisma interactive transactions on Postgres run at READ COMMITTED (verified
 * empirically: `SELECT current_setting('transaction_isolation')` inside a
 * default `db.$transaction` returns "read committed"). READ COMMITTED gives
 * NO predicate locking -- a `COUNT` of active admins inside one transaction
 * does not block a concurrent transaction from updating a DIFFERENT admin's
 * row. Two admins deactivating each other simultaneously therefore each count
 * one remaining active admin, each pass the check, and both commit, leaving
 * ZERO active admins and an application nobody can administer. Wrapping the
 * count in a transaction changes nothing about that; it only makes the race
 * harder to see in review.
 *
 * A conditional `updateMany` is not an alternative either: the predicate
 * needed is "another active admin exists" -- a cross-row aggregate that
 * Prisma's `where` clause cannot express, so it degrades to the same race.
 *
 * WHY THE ADVISORY LOCK OVER `isolationLevel: "Serializable"` (the other
 * legitimate mechanism, and confirmed available on this Prisma 7.10 +
 * @prisma/adapter-pg stack):
 *  1. It is DETERMINISTIC. The second transaction blocks on the lock; when it
 *     resumes, its `COUNT` is a new statement and READ COMMITTED takes a
 *     fresh snapshot per statement, so it observes the first transaction's
 *     committed change and correctly refuses. There is no abort and no retry.
 *  2. Serializable would instead let the second transaction proceed against
 *     its stale transaction-wide snapshot and rely on SSI aborting it at
 *     COMMIT with SQLSTATE 40001, which we would have to catch and retry.
 *     That correctness then hinges on Prisma mapping a driver-adapter 40001
 *     to P2034 -- an error-translation detail, not a database guarantee -- and
 *     on a retry budget that can be exhausted and surface a baffling failure
 *     to an admin.
 *  3. The critical section is one COUNT plus one UPDATE, so serializing all
 *     admin-invariant mutations globally costs nothing measurable.
 *
 * Verified empirically before adoption: with two concurrent Prisma clients,
 * the second acquired this lock in the same millisecond the first committed
 * (blocked ~815ms), confirming `$executeRaw` + `pg_advisory_xact_lock`
 * genuinely serializes through @prisma/adapter-pg.
 *
 * TRADE-OFF, stated plainly: an advisory lock is cooperative. It only excludes
 * code that takes the SAME key. That is sufficient here because every path in
 * this module that can REDUCE the active-admin count routes through this
 * helper; `createUser` and `reactivateUser` only ever increase it, which
 * cannot violate the invariant.
 */
async function withAdminInvariantLock<T>(body: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(
    async (tx) => {
      // Bound the LOCK WAIT itself, before taking the lock. Postgres applies
      // lock_timeout to advisory-lock acquisition, so a waiter that cannot get
      // the lock within this budget fails fast with SQLSTATE 55P03
      // (lock_not_available) instead of blocking.
      //
      // $executeRawUnsafe because `SET LOCAL` takes a literal, not a bind
      // parameter. The interpolated value is a numeric module constant on the
      // line above and never reaches this function from a caller.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${ADMIN_LOCK_TIMEOUT_MS}`);

      // Must be the FIRST statement after the timeout is set: the lock has to
      // be held before the count is read, or the count is exactly the
      // unserialized read it replaces.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_INVARIANT_LOCK_KEY}::bigint)`;
      return body(tx);
    },
    // CORRECTED. An earlier comment here claimed `timeout` bounds how long a
    // waiter may block on the lock. It does not, and that was measured: with
    // `timeout: 2000` a blocked waiter stayed blocked for 5832ms before Prisma
    // raised P2028, which then escaped unhandled and reached the admin as
    // "Something went wrong." Prisma's `timeout` is a deadline it checks
    // BETWEEN statements; it cannot interrupt a statement already blocked
    // inside Postgres. Only `SET LOCAL lock_timeout` above does that, and it is
    // set well below this ceiling so contention surfaces as a clean 55P03 that
    // isLockContention() turns into a real message, never as a transaction-API
    // error.
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/** Postgres SQLSTATE for "canceling statement due to lock timeout". */
const PG_LOCK_NOT_AVAILABLE = "55P03";

/**
 * Recursively looks for a `code`/`originalCode` of 55P03 anywhere in a Prisma
 * error's `meta`.
 *
 * A flat `meta.code` check is NOT sufficient, and this was measured rather
 * than assumed. On this stack (Prisma 7.10 + @prisma/adapter-pg) the SQLSTATE
 * arrives nested:
 *
 *   meta = { driverAdapterError: { cause: { code: "55P03", originalCode: ... } } }
 *
 * The nesting is a driver-adapter implementation detail with no stability
 * guarantee, so this walks the object instead of hard-coding that path. Depth
 * is capped, which also makes a cyclic structure safe.
 */
function hasLockTimeoutCode(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (
    record.code === PG_LOCK_NOT_AVAILABLE ||
    record.originalCode === PG_LOCK_NOT_AVAILABLE
  ) {
    return true;
  }

  return Object.values(record).some((child) => hasLockTimeoutCode(child, depth + 1));
}

/**
 * True for the failure shapes that mean "someone else held the admin-invariant
 * lock", as opposed to a genuine bug.
 *
 *  - P2010 carrying SQLSTATE 55P03: `SET LOCAL lock_timeout` fired while
 *    waiting for pg_advisory_xact_lock. This is the expected path, and it was
 *    measured: a blocked waiter threw P2010 after 3044ms with
 *    `Raw query failed. Code: 55P03. Message: canceling statement due to lock
 *    timeout`. The message substring is checked as a fallback for exactly the
 *    case where the nested meta shape changes under us.
 *  - P2028: Prisma's own transaction deadline. Kept as a belt: if a future
 *    edit removes lock_timeout or raises it past `timeout`, contention
 *    degrades to this instead of to an unhandled crash reaching the admin as
 *    "Something went wrong."
 *
 * Anything else is re-thrown. This must never swallow a real error into a
 * "try again" message the admin would then retry forever.
 */
function isLockContention(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (err.code === "P2028") {
    return true;
  }

  if (err.code === "P2010") {
    return hasLockTimeoutCode(err.meta) || err.message.includes(PG_LOCK_NOT_AVAILABLE);
  }

  return false;
}

const LOCK_CONTENTION_ERROR = "Another admin is changing accounts right now. Try again.";

/**
 * Counts ACTIVE admins other than `excludeUserId`.
 *
 * `isActive: true` is essential. Counting inactive admins too would wrongly
 * refuse demoting an already-deactivated admin, whose demotion cannot reduce
 * the number of admins who can actually log in. Excluding the target is what
 * makes the result mean "who would be left".
 *
 * `hashedPassword: { not: null }` is equally essential and was missing. The
 * column is nullable, and authorize() (src/auth.ts) refuses any row with
 * `!user.hashedPassword` -- so an admin without one can never sign in. Counting
 * such a row would let this guard rail report "another admin remains" and
 * happily deactivate the last admin who can ACTUALLY log in, which is the exact
 * lockout the invariant exists to prevent. With this clause the count means
 * what the guard rail claims it means: someone can still log in and administer.
 */
async function countOtherActiveAdmins(tx: Prisma.TransactionClient, excludeUserId: string) {
  return tx.user.count({
    where: {
      role: "admin",
      isActive: true,
      hashedPassword: { not: null },
      id: { not: excludeUserId },
    },
  });
}

const LAST_ADMIN_ERROR =
  "This is the last active admin. Promote or reactivate another admin first, otherwise nobody would be able to administer the system.";

/**
 * Creates a new staff account and returns its one-time temporary password.
 *
 * The password is GENERATED here rather than chosen by the admin: an admin
 * who picks someone else's password knows it, and people reuse passwords.
 * `mustChangePassword: true` means requireRole() bounces the new user to
 * /change-password until they replace it, so the admin's knowledge of the
 * temporary value has a short life.
 *
 * Returns { tempPassword } -- the single place that value appears. Show it
 * once, deliver it out-of-band, do not log it.
 */
export async function createUser(formData: FormData) {
  const actor = await requireRole(ADMIN_MANAGE_ROLES);

  const parsed = createUserSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // createUserSchema already trims and lowercases. Repeated here because this
  // is the invariant that matters most on this write and it must survive a
  // future edit to the schema: authorize() looks up `email.toLowerCase()`
  // (src/auth.ts:51), so a row stored with any uppercase character can never
  // be logged into, and the failure is indistinguishable from a wrong
  // password. Cheap, idempotent, and it fails safe.
  const email = parsed.data.email.toLowerCase();

  // Hash BEFORE opening any transaction. bcrypt at cost 10 is deliberately
  // CPU-expensive; doing it inside a transaction would pin a pooled database
  // connection for the whole computation for no reason.
  const tempPassword = generateTempPassword();
  const hashedPassword = await hash(tempPassword, BCRYPT_COST);

  try {
    const user = await db.user.create({
      data: {
        name: parsed.data.name,
        email,
        hashedPassword,
        role: parsed.data.role,
        isActive: true,
        mustChangePassword: true,
      },
      select: { id: true },
    });

    logUserLifecycle("create", actor.id, user.id);
    revalidatePath(USERS_PATH);

    return { success: true as const, userId: user.id, email, tempPassword };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Covers case-only collisions too: the address was lowercased above, so
      // "Alice@x.com" collides with an existing "alice@x.com" here rather
      // than creating a second, unreachable account.
      return { error: "An account with that email address already exists." };
    }
    throw err;
  }
}

/**
 * Issues a new one-time temporary password for ANOTHER user and forces them
 * to change it at next login.
 *
 * REFUSES A SELF-TARGET, and this is a real recovery property rather than
 * tidiness. An admin who resets their own password sees the value exactly
 * once; if they lose it, there is no way back in -- self-serve password reset
 * is out of scope for this phase, and `npm run bootstrap:admin` refuses an
 * email that already exists. A sole admin could permanently lock the whole
 * organisation out of its own system with one click. Their own password is
 * changed at /change-password, where they type the replacement themselves and
 * therefore know it.
 */
export async function resetUserPassword(id: string) {
  const actor = await requireRole(ADMIN_MANAGE_ROLES);

  if (id === actor.id) {
    return {
      error:
        "You cannot reset your own password here -- the new value is shown only once and there is no self-serve recovery if you lose it. Use Change password instead, where you choose the new password yourself.",
    };
  }

  // Outside any transaction: bcrypt is CPU-bound.
  const tempPassword = generateTempPassword();
  const hashedPassword = await hash(tempPassword, BCRYPT_COST);

  try {
    await db.user.update({
      where: { id },
      // tokenVersion is what makes this a real reset. Rotating hashedPassword
      // alone does NOT log the target out: their session is a self-contained
      // signed JWT that never re-checks the hash, so before this increment an
      // attacker riding a stolen session survived the reset untouched -- and
      // could then use /change-password to set a password of their own.
      // Incrementing invalidates every token minted for this account (see
      // getCurrentUser() in src/lib/session.ts), which is what the admin UI
      // already promised was happening.
      data: { hashedPassword, mustChangePassword: true, tokenVersion: { increment: 1 } },
      select: { id: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "User not found" };
    }
    throw err;
  }

  logUserLifecycle("reset_password", actor.id, id);
  revalidatePath(USERS_PATH);

  return { success: true as const, tempPassword };
}

/**
 * Changes another user's role.
 *
 * Two guard rails: no self-target (an admin cannot demote themselves out of
 * the only role that could undo it), and demoting the last active admin is
 * refused under the advisory lock so it holds against a concurrent
 * deactivation of the other admin.
 */
export async function updateUserRole(id: string, formData: FormData) {
  const actor = await requireRole(ADMIN_MANAGE_ROLES);

  // Compared against the id requireRole() resolved from the session -- never
  // against anything the client supplied, which is the whole point.
  if (id === actor.id) {
    return {
      error:
        "You cannot change your own role. Ask another admin to do it, so an admin can never demote themselves out of the only role that can undo it.",
    };
  }

  const parsed = updateUserRoleSchema.safeParse({ role: formData.get("role") });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const role = parsed.data.role;

  const result = await withAdminInvariantLock(async (tx) => {
    const target = await tx.user.findUnique({
      where: { id },
      select: { id: true, role: true, isActive: true },
    });

    if (!target) {
      return { error: "User not found" };
    }

    // Only an ACTIVE admin losing the admin role reduces the population the
    // invariant protects. Demoting an inactive admin changes nothing about
    // who can log in and administer, so it is never blocked.
    if (target.role === "admin" && target.isActive && role !== "admin") {
      if ((await countOtherActiveAdmins(tx, id)) === 0) {
        return { error: LAST_ADMIN_ERROR };
      }
    }

    await tx.user.update({ where: { id }, data: { role }, select: { id: true } });

    return { success: true as const };
    // .catch() rather than a surrounding try/catch on purpose: an annotated
    // `let` would collapse TypeScript's normalized union (every member gaining
    // `error?: undefined` / `success?: undefined`) into a strict discriminated
    // union, which breaks the `"error" in result && result.error` form the
    // client components use. This keeps the action's public return shape
    // exactly as it was.
  }).catch((err: unknown) => {
    // Lock contention is a normal outcome of two admins acting at once, not a
    // fault. Return it as a message the admin can act on; anything else is a
    // real failure and must keep propagating.
    if (isLockContention(err)) {
      return { error: LOCK_CONTENTION_ERROR };
    }
    throw err;
  });

  if ("error" in result) {
    return result;
  }

  logUserLifecycle(`role:${role}`, actor.id, id);
  revalidatePath(USERS_PATH);

  return result;
}

/**
 * Offboards a user by clearing `isActive`. NOT a delete -- the row and every
 * ticket, comment and time entry hanging off it stay exactly where they are.
 * getCurrentUser() resolves an inactive user to null, so the effect is
 * immediate on their next request rather than at session expiry.
 */
export async function deactivateUser(id: string) {
  const actor = await requireRole(ADMIN_MANAGE_ROLES);

  if (id === actor.id) {
    return {
      error:
        "You cannot deactivate your own account. Ask another admin to do it, so you cannot lock yourself out mid-session.",
    };
  }

  const result = await withAdminInvariantLock(async (tx) => {
    const target = await tx.user.findUnique({
      where: { id },
      select: { id: true, role: true, isActive: true },
    });

    if (!target) {
      return { error: "User not found" };
    }

    // Idempotent: already offboarded is the requested end state, not an error.
    if (!target.isActive) {
      return { success: true as const };
    }

    if (target.role === "admin" && (await countOtherActiveAdmins(tx, id)) === 0) {
      return { error: LAST_ADMIN_ERROR };
    }

    await tx.user.update({ where: { id }, data: { isActive: false }, select: { id: true } });

    return { success: true as const };
  }).catch((err: unknown) => {
    // See updateUserRole for why contention is returned rather than thrown,
    // and why this is a .catch() rather than a try/catch.
    if (isLockContention(err)) {
      return { error: LOCK_CONTENTION_ERROR };
    }
    throw err;
  });

  if ("error" in result) {
    return result;
  }

  logUserLifecycle("deactivate", actor.id, id);
  revalidatePath(USERS_PATH);

  return { success: true as const };
}

/**
 * Restores access to a deactivated account.
 *
 * No guard rail and no lock: reactivating can only INCREASE the number of
 * active admins, and the invariant is a floor, not a ceiling. The existing
 * password still works -- reactivation is not a password reset.
 */
export async function reactivateUser(id: string) {
  const actor = await requireRole(ADMIN_MANAGE_ROLES);

  try {
    await db.user.update({
      where: { id },
      data: { isActive: true },
      select: { id: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "User not found" };
    }
    throw err;
  }

  logUserLifecycle("reactivate", actor.id, id);
  revalidatePath(USERS_PATH);

  return { success: true as const };
}
