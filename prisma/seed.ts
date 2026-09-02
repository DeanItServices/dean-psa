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
      // Not `update: {}`: a re-seed against a database that already holds
      // these accounts must still set the activation columns, or the E2E
      // login fixture breaks once the active-user gate is live.
      update: {
        isActive: true,
        mustChangePassword: false,
      },
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
