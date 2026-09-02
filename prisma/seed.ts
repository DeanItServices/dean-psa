import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hash } from "bcryptjs";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter });

/**
 * Local-development-only seed data. The shared password below is a fixed,
 * well-known test credential intended solely for this MSP PSA's local/dev
 * database seeding -- it must never be reused for any real account and must
 * never be logged in plaintext (only the hash and the emails are ever
 * written to storage or console output).
 */
const TEST_PASSWORD = "Password123!";

const TEST_USERS: Array<{ email: string; name: string; role: Role }> = [
  { email: "technician@mspdemo.local", name: "Technician Test User", role: "technician" },
  { email: "dispatcher@mspdemo.local", name: "Dispatcher Test User", role: "dispatcher" },
  { email: "sales@mspdemo.local", name: "Sales Test User", role: "sales" },
  { email: "finance@mspdemo.local", name: "Finance Test User", role: "finance" },
  { email: "admin@mspdemo.local", name: "Admin Test User", role: "admin" },
];

async function main() {
  // Guard rail: this script creates well-known-password test accounts and
  // must never run against a real database. Nothing currently auto-invokes
  // it, but a misconfigured DATABASE_URL pointing at production should not
  // be enough to seed it with test credentials.
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED_IN_PRODUCTION !== "true") {
    throw new Error(
      "Refusing to run prisma/seed.ts with NODE_ENV=production. This script creates test " +
        "accounts with a shared, well-known password and must not be run against a real " +
        "database. If you are certain this is intentional (e.g. a disposable staging " +
        "environment), set ALLOW_SEED_IN_PRODUCTION=true to override.",
    );
  }

  const hashedPassword = await hash(TEST_PASSWORD, 10);

  for (const { email, name, role } of TEST_USERS) {
    await db.user.upsert({
      where: { email },
      // `update: {}` -- CREATE ONLY, NEVER CLOBBER. Chosen deliberately over
      // "restore the fixture fully" in review cycle 2.
      //
      // The previous version wrote `isActive: true, mustChangePassword: false`
      // on every re-seed, justified as keeping the E2E login fixture working.
      // Two things were wrong with that:
      //
      //  1. It did not do what it claimed. The branch omitted hashedPassword,
      //     role and name, so it never actually restored the fixture -- it only
      //     ever reset the two SECURITY-STATE columns, which is the one part
      //     that is dangerous to reset.
      //  2. Its only guard is NODE_ENV === "production", which is unset in an
      //     ordinary dev shell. `npm run db:seed` with DATABASE_URL pointed at
      //     any other database therefore silently REACTIVATED five accounts
      //     whose shared password is published at line 15 of this file --
      //     including an admin. Reactivating a deliberately deactivated
      //     well-known-credential account is exactly the outcome Phase 7's
      //     offboarding feature exists to prevent.
      //
      // So this script now only ever CREATES. It never mutates a row it did not
      // create, which is the correct posture for a script whose safety rail is
      // an environment variable. The E2E concern it was meant to solve is
      // narrower than it looked: fresh databases get the columns from `create`
      // below, and a seed account that someone deliberately deactivated during
      // testing is now recoverable through the product itself -- /admin/users
      // has a Reactivate action, which is precisely what this phase added and
      // did not exist when the previous comment was written.
      update: {},
      create: {
        email,
        name,
        role,
        hashedPassword,
        isActive: true,
        mustChangePassword: false,
      },
    });
  }

  console.log(`Seed complete: upserted ${TEST_USERS.length} test users (one per role).`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
