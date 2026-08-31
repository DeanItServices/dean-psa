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
  const hashedPassword = await hash(TEST_PASSWORD, 10);

  for (const { email, name, role } of TEST_USERS) {
    await db.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        name,
        role,
        hashedPassword,
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
