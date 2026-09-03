import { randomBytes } from "node:crypto";
import { compare, hash } from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { test, expect } from "@playwright/test";
import { loginWith, newIsolatedContext } from "./fixtures";
import { E2E_EMAIL_DOMAIN, E2E_EMAIL_PREFIX, disconnectPrisma, prisma } from "./db";
// Relative, not "@/lib/...", for the same reason user-lifecycle.spec.ts is:
// the alias resolves through tsconfig's `paths`, and the runner's resolver is
// not the bundler's. A relative specifier cannot be wrong.
import { MIN_PASSWORD_LENGTH } from "../src/lib/validations/user";
import {
  BOOTSTRAP_BCRYPT_COST,
  RESET_ABORTED_MESSAGE,
  createBootstrapAdmin,
  existingAccountMessage,
  explainPrismaFailure,
  findBootstrapAccount,
  isResetConfirmed,
  missingAccountMessage,
  normalizeBootstrapEmail,
  notAdminMessage,
  prismaErrorCode,
  resetBootstrapAdminPassword,
  resolveDatabaseUrl,
  validateBootstrapPassword,
} from "../src/lib/bootstrap-admin";

/**
 * E2E spec: the first-admin bootstrap logic (src/lib/bootstrap-admin.ts).
 *
 * WHAT THIS CLOSES. "The bootstrap script creates an admin, refuses to
 * overwrite one, and enforces the password floor" has been a Phase 7 criterion
 * since cycle 1 and has been graded ASSERTED ONLY through three review cycles:
 * its evidence was a hand-driven terminal transcript and `grep -q`. It is the
 * only path to a production account and it is the single most consequential
 * write in the system -- an operator who ends up with a technician instead of
 * an admin on a fresh deployment has no Admin nav, no way to create anyone
 * else, and (now that the seed is retired as the documented path) no way back
 * except hand-written SQL.
 *
 * It was untestable because scripts/create-admin.ts gated everything behind
 * `process.stdin.isTTY` and a hidden prompt. The script has since been split:
 * every decision that writes now lives in src/lib/bootstrap-admin.ts, takes
 * already-collected values and a PrismaClient, and returns a result. This spec
 * drives that module directly, against the real database, with the same
 * `prisma()` client the rest of the suite uses.
 *
 * WHAT REMAINS UNTESTABLE, AND IT IS NOT NOTHING. The interactive shell in
 * scripts/create-admin.ts -- argv parsing, the `process.stdin.isTTY` gate, the
 * double password prompt, and the echo suppression that keeps the typed
 * password off the terminal -- is untestable BY CONSTRUCTION here: it exists
 * precisely to refuse a non-TTY caller, so no runner can drive it, and its own
 * summary already flags that a refactor of the echo muting could silently
 * un-suppress the echo with nothing to catch it. This spec does not cover it
 * and does not pretend to. What it does mean is that the shell now contains
 * nothing but I/O: no validation, no refusal, no write.
 *
 * THE FIVE SEEDED FIXTURES ARE NEVER TOUCHED. Every account here is created by
 * this file under `e2e-lifecycle-<run>-…@e2e.invalid`, deleted by the afterAll
 * below, and swept by pattern in e2e/global-teardown.ts if a worker dies first.
 *
 * WHY THIS FILE IS IN THE `lifecycle` PLAYWRIGHT PROJECT (playwright.config.ts)
 * RATHER THAN ONE OF ITS OWN. It creates ADMIN accounts, briefly and with real
 * passwords. e2e/last-active-admin.spec.ts can only be correct while the seeded
 * admin is the only admin who can still log in, and it guarantees that by
 * declaring `dependencies: ["lifecycle"]`. Putting this file in that project is
 * what makes its admins gone before that spec starts; a project of its own
 * would run concurrently with it and break its precondition.
 *
 * Tagged @user-lifecycle so Phase 7's gate run includes it.
 */

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Addresses this file created, in STORED (lowercase) form, for teardown. */
const createdEmails = new Set<string>();

function subjectEmail(label: string): string {
  const email = `${E2E_EMAIL_PREFIX}${RUN_ID}-${label}${E2E_EMAIL_DOMAIN}`;
  createdEmails.add(email.toLowerCase());
  return email;
}

/** A password comfortably over the floor, generated per call, never a literal. */
function freshPassword(label: string): string {
  const password = `e2e-${label}-${randomBytes(12).toString("base64url")}`;
  expect(
    password.length,
    "generated E2E passwords must clear the policy floor they are asserted against",
  ).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  return password;
}

/**
 * An environment object to hand resolveDatabaseUrl.
 *
 * Double cast because `NodeJS.ProcessEnv` is augmented (NODE_ENV is required)
 * and the whole point of the parameter is to pass an environment that is NOT
 * this process's.
 */
function fakeEnv(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as unknown as NodeJS.ProcessEnv;
}

/** The stored row, read straight from the database rather than from a result. */
async function readRow(email: string) {
  return prisma().user.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      tokenVersion: true,
      hashedPassword: true,
    },
  });
}

test.afterAll(async () => {
  try {
    if (createdEmails.size > 0) {
      await prisma().user.deleteMany({ where: { email: { in: [...createdEmails] } } });
    }
  } finally {
    await disconnectPrisma();
  }
});

// ---------------------------------------------------------------------------
// Pure functions -- no database, no environment mutation
// ---------------------------------------------------------------------------

test.describe("@user-lifecycle bootstrap admin: input rules", () => {
  test("an operator-typed email is trimmed and lowercased, which is what makes the account reachable", () => {
    // NOT cosmetic. authorize() (src/auth.ts) looks the account up with
    // `email.toLowerCase()`, so an account stored with any uppercase character
    // can never be signed into -- and it fails with the same anti-enumeration
    // "Invalid email or password" a wrong password gives, so the operator gets
    // no signal at all. The end-to-end proof of that is the login test below;
    // this is the unit that has to hold for it.
    const normalized = normalizeBootstrapEmail("  Admin@Example.COM  ");
    expect(normalized.ok).toBe(true);
    expect(normalized.ok && normalized.email).toBe("admin@example.com");

    const rejected = normalizeBootstrapEmail("not-an-email");
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.message).toBe("Enter a valid email address");
  });

  test("the password floor is MIN_PASSWORD_LENGTH exactly, and is the shared constant", () => {
    const tooShort = "x".repeat(MIN_PASSWORD_LENGTH - 1);
    const result = validateBootstrapPassword(tooShort);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("password_too_short");
    // The message states BOTH numbers: an operator who is told only "too short"
    // at a hidden prompt cannot tell how far off they are.
    expect(result.ok === false && result.message).toContain(String(MIN_PASSWORD_LENGTH - 1));
    expect(result.ok === false && result.message).toContain(String(MIN_PASSWORD_LENGTH));

    expect(validateBootstrapPassword("x".repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);

    // Whitespace is a legitimate part of a password and must count toward the
    // length -- trimming here would silently move the floor.
    expect(validateBootstrapPassword(`  ${"x".repeat(MIN_PASSWORD_LENGTH - 2)}  `).ok).toBe(true);
  });

  test("the reset confirmation accepts only the target account's own address", () => {
    expect(isResetConfirmed("admin@example.com", "admin@example.com")).toBe(true);
    // Typed at a prompt: surrounding whitespace and case are the operator's
    // keyboard, not their intent.
    expect(isResetConfirmed("admin@example.com", "  Admin@Example.com \n".trim())).toBe(true);

    expect(isResetConfirmed("admin@example.com", "someone-else@example.com")).toBe(false);
    expect(isResetConfirmed("admin@example.com", "")).toBe(false);
    expect(isResetConfirmed("admin@example.com", "yes")).toBe(false);
  });

  test("resolveDatabaseUrl names the fix, and takes the environment as a parameter", () => {
    // The parameter is the point: the missing-variable message is the first
    // thing an operator sees on a fresh host, and asserting it must not mean
    // unsetting DATABASE_URL in the process this suite is running in.
    const before = process.env.DATABASE_URL;

    const missing = resolveDatabaseUrl(fakeEnv({}));
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.message).toContain("DATABASE_URL is not set.");
    // The recipe, not just the diagnosis -- and specifically the one that keeps
    // the connection string (which contains the database password) out of shell
    // history.
    expect(missing.ok === false && missing.message).toContain("set -a; . ./.env; set +a");
    expect(missing.ok === false && missing.message).toContain("npm run db:migrate:deploy");

    expect(resolveDatabaseUrl(fakeEnv({ DATABASE_URL: "   " })).ok).toBe(false);

    const present = resolveDatabaseUrl(
      fakeEnv({ DATABASE_URL: "postgres://user:pw@localhost:5432/db" }),
    );
    expect(present.ok).toBe(true);
    expect(present.ok && present.url).toBe("postgres://user:pw@localhost:5432/db");

    expect(
      process.env.DATABASE_URL,
      "asserting the missing-DATABASE_URL message must not disturb the runner's own env",
    ).toBe(before);
  });

  test("a Prisma failure is explained by code, duck-typed rather than by instanceof", () => {
    expect(prismaErrorCode({ code: "P2022" })).toBe("P2022");
    expect(prismaErrorCode(new Error("plain"))).toBeUndefined();
    expect(prismaErrorCode(null)).toBeUndefined();
    expect(prismaErrorCode({ code: 42 })).toBeUndefined();

    // P2022 is the one that matters: the migration has not been applied, and
    // the operator needs to know the running app is in the same state.
    const p2022 = explainPrismaFailure({ code: "P2022" });
    expect(p2022).toContain("npm run db:migrate:deploy");
    expect(p2022).toContain("Invalid email or password");

    expect(explainPrismaFailure({ code: "P1001" })).toContain("DATABASE_URL");
    expect(explainPrismaFailure(new Error("boom"))).toContain("Bootstrap failed:");
  });

  test("every refusal message names the account and says nothing was written", () => {
    const email = "someone@example.com";

    expect(existingAccountMessage(email)).toContain(email);
    expect(existingAccountMessage(email)).toContain("Nothing was written.");
    // The refusal has to carry the way out, or the operator's next move is SQL.
    expect(existingAccountMessage(email)).toContain(`--reset-password ${email}`);

    expect(missingAccountMessage(email)).toContain(email);
    expect(missingAccountMessage(email)).toContain("Nothing was written.");

    expect(notAdminMessage(email, "technician")).toContain('"technician"');
    expect(notAdminMessage(email, "technician")).toContain("Nothing was written.");

    expect(RESET_ABORTED_MESSAGE).toContain("Nothing was written.");
  });
});

// ---------------------------------------------------------------------------
// The write path, against the real database
// ---------------------------------------------------------------------------

test.describe("@user-lifecycle bootstrap admin: creating the first admin", () => {
  test("the role is written EXPLICITLY as admin -- the schema's own default is technician", async () => {
    // THE DEFECT THE READ-BACK EXISTS TO CATCH, demonstrated rather than
    // described. prisma/schema.prisma declares `role Role @default(technician)`,
    // so a dropped `role: "admin"` in createBootstrapAdmin does not fail: it
    // quietly produces a technician. This creates a row the way a dropped role
    // would -- omitting the column entirely -- and shows what comes back.
    const defaultEmail = subjectEmail("schema-default");
    const defaulted = await prisma().user.create({
      data: {
        name: "Schema Default Probe",
        email: defaultEmail,
        hashedPassword: await hash(freshPassword("probe"), BOOTSTRAP_BCRYPT_COST),
      },
      select: { role: true },
    });
    expect(
      defaulted.role,
      "if this is no longer 'technician', the read-back below is guarding a different defect",
    ).toBe("technician");

    // Now the real path, for comparison.
    const email = subjectEmail("create");
    const password = freshPassword("create");

    const result = await createBootstrapAdmin(prisma(), {
      name: "Bootstrap Admin",
      email,
      password,
    });

    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    expect(result.ok && result.user.role).toBe("admin");

    // Asserted against the STORED row, not the returned one: the claim is about
    // what is in the database, and a function returning its own input would
    // satisfy the weaker check.
    const row = await readRow(email);
    expect(row?.role).toBe("admin");
    expect(row?.isActive).toBe(true);
    // The operator chose this password at a hidden prompt, so there is nothing
    // to force them to change -- unlike an /admin/users-created account.
    expect(row?.mustChangePassword).toBe(false);
    expect(row?.tokenVersion).toBe(0);
    expect(row?.name).toBe("Bootstrap Admin");

    // The password that was typed is the password that was stored, at the cost
    // this codebase standardizes on.
    expect(row?.hashedPassword).toMatch(new RegExp(`^\\$2[aby]\\$${BOOTSTRAP_BCRYPT_COST}\\$`));
    expect(await compare(password, row!.hashedPassword!)).toBe(true);
  });

  test("a bootstrap admin typed in mixed case is stored lowercased AND can actually sign in", async ({
    browser,
  }) => {
    // The end-to-end version of the normalization unit above. If the address
    // were stored as typed, authorize()'s `email.toLowerCase()` lookup would
    // miss it and the login below would fail with "Invalid email or password"
    // -- the account would exist and be unusable, which is the exact failure
    // mode the bootstrap path cannot afford.
    const typed = `${E2E_EMAIL_PREFIX}${RUN_ID}-MixedCase${E2E_EMAIL_DOMAIN.toUpperCase()}`;
    createdEmails.add(typed.toLowerCase());
    const password = freshPassword("mixed");

    const result = await createBootstrapAdmin(prisma(), {
      name: "Mixed Case Admin",
      email: typed,
      password,
    });
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    expect(result.ok && result.user.email).toBe(typed.toLowerCase());

    // findBootstrapAccount must find it from the RAW typed form too, or a
    // second bootstrap run would be told the address is free and the create
    // would fall through to the unique index.
    const found = await findBootstrapAccount(prisma(), typed);
    expect(found?.email).toBe(typed.toLowerCase());
    expect(found?.role).toBe("admin");

    const context = await newIsolatedContext(browser);
    try {
      const page = await context.newPage();
      // Lands on "/" and not "/change-password": mustChangePassword is false.
      await loginWith(page, typed, password);

      // Role admin, proven by reaching an admin-only route rather than by
      // reading the row back a second time.
      await page.goto("/admin/users");
      await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("an email that is already taken is refused, in any case, and nothing is overwritten", async () => {
    const email = subjectEmail("duplicate");
    const password = freshPassword("duplicate");

    const first = await createBootstrapAdmin(prisma(), {
      name: "First Admin",
      email,
      password,
    });
    expect(first.ok, first.ok ? "" : first.message).toBe(true);
    const before = await readRow(email);

    const second = await createBootstrapAdmin(prisma(), {
      name: "Impostor",
      email: email.toUpperCase(),
      password: freshPassword("duplicate-2"),
    });

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.code).toBe("already_exists");
    expect(second.ok === false && second.message).toBe(existingAccountMessage(email));

    // "Refused" means the row is untouched, not that a second row was avoided:
    // the hazard is a silent overwrite of the working admin's credential.
    const after = await readRow(email);
    expect(after?.id).toBe(before?.id);
    expect(after?.name).toBe("First Admin");
    expect(after?.hashedPassword).toBe(before?.hashedPassword);
    expect(await compare(password, after!.hashedPassword!)).toBe(true);
  });

  test("a password under the floor is refused and NO account is created", async () => {
    const email = subjectEmail("short");

    const result = await createBootstrapAdmin(prisma(), {
      name: "Too Short",
      email,
      password: "x".repeat(MIN_PASSWORD_LENGTH - 1),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("password_too_short");
    // Refusing after writing would leave a production admin with a password
    // below the floor every other account in the system is held to.
    expect(await readRow(email)).toBeNull();
  });

  test("invalid input is refused by the same schema /admin/users uses, and writes nothing", async () => {
    const badEmail = await createBootstrapAdmin(prisma(), {
      name: "Bad Email",
      email: "not-an-email",
      password: freshPassword("bad-email"),
    });
    expect(badEmail.ok).toBe(false);
    expect(badEmail.ok === false && badEmail.code).toBe("invalid_input");

    const email = subjectEmail("blank-name");
    const blankName = await createBootstrapAdmin(prisma(), {
      name: "   ",
      email,
      password: freshPassword("blank-name"),
    });
    expect(blankName.ok).toBe(false);
    expect(blankName.ok === false && blankName.code).toBe("invalid_input");
    expect(blankName.ok === false && blankName.message).toBe("Name is required");
    expect(await readRow(email)).toBeNull();
  });
});

test.describe("@user-lifecycle bootstrap admin: break-glass password reset", () => {
  test("a reset rotates the hash, increments tokenVersion, and does NOT reactivate the account", async () => {
    const email = subjectEmail("reset");
    const original = freshPassword("reset-1");

    const created = await createBootstrapAdmin(prisma(), {
      name: "Reset Subject",
      email,
      password: original,
    });
    expect(created.ok, created.ok ? "" : created.message).toBe(true);

    // Deactivated FIRST, on purpose. "Does not touch isActive" is the claim --
    // reactivating an offboarded account is a decision, not a side effect of a
    // password reset -- and it can only be checked from a deactivated start.
    await prisma().user.update({ where: { email }, data: { isActive: false } });
    const before = await readRow(email);
    expect(before?.tokenVersion).toBe(0);

    const replacement = freshPassword("reset-2");
    const result = await resetBootstrapAdminPassword(prisma(), {
      email: email.toUpperCase(),
      password: replacement,
      confirmation: `  ${email.toUpperCase()}  `,
    });

    expect(result.ok, result.ok ? "" : result.message).toBe(true);

    const after = await readRow(email);
    // THE REVOCATION. Break-glass recovery is used precisely when an account may
    // be compromised: a JWT is self-contained, so rotating the hash alone evicts
    // nothing. getCurrentUser() refuses any token whose stamped tokenVersion
    // differs from this column, so the increment is what ends existing sessions.
    expect(after?.tokenVersion).toBe(1);
    expect(after?.isActive, "a password reset must not reactivate an account").toBe(false);
    expect(after?.mustChangePassword).toBe(false);
    expect(after?.role).toBe("admin");
    expect(after?.id).toBe(before?.id);

    expect(await compare(replacement, after!.hashedPassword!)).toBe(true);
    expect(
      await compare(original, after!.hashedPassword!),
      "the previous password must no longer verify",
    ).toBe(false);
  });

  test("a reset is refused for an account that is not an admin, and writes nothing", async () => {
    // Created directly, not through the bootstrap path, because the bootstrap
    // path only ever produces admins -- which is itself the point of the flag.
    const email = subjectEmail("not-admin");
    const password = freshPassword("not-admin");
    await prisma().user.create({
      data: {
        name: "Technician Subject",
        email,
        role: "technician",
        hashedPassword: await hash(password, BOOTSTRAP_BCRYPT_COST),
        isActive: true,
        mustChangePassword: false,
      },
    });
    const before = await readRow(email);

    const result = await resetBootstrapAdminPassword(prisma(), {
      email,
      password: freshPassword("not-admin-2"),
      confirmation: email,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("not_admin");
    expect(result.ok === false && result.message).toBe(notAdminMessage(email, "technician"));

    const after = await readRow(email);
    expect(after?.hashedPassword).toBe(before?.hashedPassword);
    expect(after?.tokenVersion).toBe(before?.tokenVersion);
  });

  test("a reset is refused when the confirmation does not match, and writes nothing", async () => {
    const email = subjectEmail("unconfirmed");
    const original = freshPassword("unconfirmed");

    const created = await createBootstrapAdmin(prisma(), {
      name: "Unconfirmed Subject",
      email,
      password: original,
    });
    expect(created.ok, created.ok ? "" : created.message).toBe(true);
    const before = await readRow(email);

    const result = await resetBootstrapAdminPassword(prisma(), {
      email,
      password: freshPassword("unconfirmed-2"),
      // The rule is the TARGET ACCOUNT'S address typed back -- "yes" is the
      // answer an operator gives a prompt they are not reading.
      confirmation: "yes",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("not_confirmed");
    expect(result.ok === false && result.message).toBe(RESET_ABORTED_MESSAGE);

    const after = await readRow(email);
    expect(after?.hashedPassword).toBe(before?.hashedPassword);
    expect(after?.tokenVersion).toBe(0);
    expect(
      await compare(original, after!.hashedPassword!),
      "the original password must still be the account's password",
    ).toBe(true);
  });

  test("a reset for an address with no account is refused with the create instruction", async () => {
    const email = subjectEmail("absent");

    const result = await resetBootstrapAdminPassword(prisma(), {
      email,
      password: freshPassword("absent"),
      confirmation: email,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("not_found");
    expect(result.ok === false && result.message).toBe(missingAccountMessage(email));
    expect(await readRow(email)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Branches the real database cannot reach
// ---------------------------------------------------------------------------

/**
 * A stub standing in for PrismaClient, for the two branches a working database
 * will never produce.
 *
 * This is NOT a substitute for the real-database tests above -- every claim
 * about what is stored is made against the real database. It exists because
 * `role_verification_failed` and the P2002 race are, by design, unreachable
 * while the schema and the unique index behave: the first requires the database
 * to return a role other than the one written, the second requires losing a
 * race to a concurrent create. Leaving them unexecuted would mean the
 * read-back -- the one defence against the dropped-`role` defect -- had itself
 * never run.
 */
function stubDb(behaviour: {
  findUnique?: () => Promise<unknown>;
  create?: () => Promise<{ id: string }>;
  findUniqueOrThrow?: () => Promise<unknown>;
}): PrismaClient {
  return {
    user: {
      findUnique: async () => (behaviour.findUnique ? behaviour.findUnique() : null),
      create: async () =>
        behaviour.create ? behaviour.create() : Promise.reject(new Error("no create stubbed")),
      findUniqueOrThrow: async () =>
        behaviour.findUniqueOrThrow
          ? behaviour.findUniqueOrThrow()
          : Promise.reject(new Error("no findUniqueOrThrow stubbed")),
    },
  } as unknown as PrismaClient;
}

test.describe("@user-lifecycle bootstrap admin: read-back and race branches", () => {
  test("a row that reads back as a non-admin fails the run and hands back what WAS written", async () => {
    const written = {
      id: "stub-id",
      email: "stub@e2e.invalid",
      name: "Stub",
      role: "technician",
      isActive: true,
      mustChangePassword: false,
      tokenVersion: 0,
    };

    const result = await createBootstrapAdmin(
      stubDb({
        findUnique: async () => null,
        create: async () => ({ id: "stub-id" }),
        findUniqueOrThrow: async () => written,
      }),
      { name: "Stub", email: "stub@e2e.invalid", password: freshPassword("stub") },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("role_verification_failed");
    expect(result.ok === false && result.message).toContain('"technician"');
    // The failure variant's optional `user` is populated ONLY here, so the
    // operator can be shown the account they actually have rather than being
    // told to guess.
    expect(result.ok === false && result.user).toEqual(written);
  });

  test("losing the create race to a concurrent bootstrap is reported as already_exists", async () => {
    const result = await createBootstrapAdmin(
      stubDb({
        // The lookup saw nothing; the unique index did.
        findUnique: async () => null,
        create: async () => Promise.reject({ code: "P2002" }),
      }),
      { name: "Racer", email: "racer@e2e.invalid", password: freshPassword("race") },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("already_exists");
    expect(result.ok === false && result.message).toContain("racer@e2e.invalid");
  });

  test("a create failure that is not P2002 is re-thrown, not swallowed as a refusal", async () => {
    // A refusal is a decision the operator is shown; an unexpected database
    // error is not one to translate into "already exists".
    await expect(
      createBootstrapAdmin(
        stubDb({
          findUnique: async () => null,
          create: async () => Promise.reject({ code: "P2022" }),
        }),
        { name: "Broken", email: "broken@e2e.invalid", password: freshPassword("broken") },
      ),
    ).rejects.toMatchObject({ code: "P2022" });
  });
});
