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

/**
 * The one variable that permits this script to run. Absent or anything other
 * than exactly "true" -> refuse.
 */
const SEED_OPT_IN = "ALLOW_DEMO_SEED";

/**
 * Best-effort, CREDENTIAL-FREE description of the database this run would hit,
 * so the refusal can tell the operator which server they were about to seed.
 * Host and database name only -- the password lives in this string and must
 * never reach stdout/stderr. Unparseable input yields null and the line is
 * simply omitted (`.env.example` documents a DATABASE_URL containing literal
 * `${...}` references that plain dotenv does not expand, so this must not be
 * allowed to throw).
 */
function describeTarget(): string | null {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const database = url.pathname.replace(/^\//, "");
    return database ? `${url.host}/${database}` : url.host;
  } catch {
    return null;
  }
}

/**
 * SEED SAFETY GATE -- FAIL CLOSED (rewritten in review cycle 2 of Phase 8).
 *
 * WHAT THE OLD GATE WAS AND WHY IT WAS INERT. It read:
 *
 *     if (process.env.NODE_ENV === "production" && ALLOW_SEED_IN_PRODUCTION !== "true")
 *
 * `NODE_ENV=production` is set at `Dockerfile:18` -- i.e. INSIDE the app
 * container, for the server process. It is not set in an operator's shell, and
 * this script is host-side tooling: DEPLOYMENT.md lists `npm run db:seed`
 * alongside `db:migrate:deploy` and `bootstrap:admin` as commands run on the
 * deployment host, whose prescribed prelude (`set -a; . ./.env; set +a`)
 * exports the PRODUCTION `DATABASE_URL`. So the condition could never be true
 * on the machine where the damage happens: one `npm run db:seed` on the
 * deployment host created five accounts sharing the password published at
 * line 15 of this file, one of them role `admin`, on an internet-exposed
 * deployment. Verified: with NODE_ENV unset, execution reached the upsert loop
 * and stopped only at the network layer.
 *
 * WHY A HOST-BASED CHECK CANNOT REPLACE IT. The obvious "refuse unless
 * DATABASE_URL points at localhost" is WRONG HERE and must not be added:
 * since 08-03 the `db` service publishes `127.0.0.1:${DB_PORT}:5432`, so the
 * production connection string ON the deployment host is itself
 * `...@localhost:5432/...`. A development database and the production database
 * are indistinguishable to this process -- same host, same port, same shape.
 * Nothing observable from inside the script separates them. Only the human
 * running it knows which one it is, so the gate asks the human.
 *
 * THE POSTURE. Refuse by default; proceed only on an explicit, purpose-named
 * opt-in. Dev and CI keep working (`ALLOW_DEMO_SEED=true npm run db:seed`);
 * `e2e/global-setup.ts` / `global-teardown.ts` still get their five
 * `*@mspdemo.local` fixtures. Nothing in this repository invokes the seed
 * automatically -- only a human does -- so the cost of the opt-in is one
 * documented prefix, and the benefit is that the dangerous default is now
 * "no".
 *
 * ALLOW_SEED_IN_PRODUCTION IS DELIBERATELY NO LONGER HONOURED. It was half of
 * an inert condition, it is named for a thing nobody should ever do, and a
 * copy of it parked in a production `.env` must not be able to re-arm this
 * script. If it is set we say so in the refusal rather than silently ignoring
 * an operator who is following the old runbook.
 */
function assertSeedingIsIntended(): void {
  if (process.env[SEED_OPT_IN] === "true") return;

  const target = describeTarget();
  const staleOverride = process.env.ALLOW_SEED_IN_PRODUCTION !== undefined;

  throw new Error(
    [
      "Refusing to seed. prisma/seed.ts creates five demo accounts that all share one " +
        "password published in plaintext in this file, and one of them has role \"admin\". " +
        "It is a local-development and E2E fixture, never a deployment tool.",
      "",
      "This script refuses BY DEFAULT. If this really is a development or test database, " +
        "opt in explicitly on the command line:",
      "",
      `    ${SEED_OPT_IN}=true npm run db:seed`,
      "",
      target
        ? `That would seed: ${target} -- confirm it is your development database first.`
        : "DATABASE_URL is unset or unparseable; confirm which database you are pointing at.",
      "",
      `Set ${SEED_OPT_IN} inline, for one command. Do NOT put it in .env: DEPLOYMENT.md ` +
        "tells operators to run `set -a; . ./.env; set +a` before host-side commands, so a " +
        "value parked there would re-arm this script on the deployment host -- exactly the " +
        "failure this gate exists to prevent.",
      "",
      "To create a real administrator on a real deployment, use `npm run bootstrap:admin`. " +
        "Never this script.",
      "",
      "Why an explicit opt-in rather than an automatic safety check: the previous guard only " +
        "fired when NODE_ENV=production, which is set inside the app container (Dockerfile:18) " +
        "and is unset in your shell, so it could never fire for a host-side `npm run db:seed`. " +
        "A \"refuse unless DATABASE_URL is localhost\" check cannot replace it either -- " +
        "Postgres is published on 127.0.0.1, so the production database is also reachable at " +
        "localhost. Nothing this script can observe tells the two apart. You can.",
      ...(staleOverride
        ? [
            "",
            "NOTE: ALLOW_SEED_IN_PRODUCTION is set in this environment. It is no longer " +
              `consulted -- it gated on the inert NODE_ENV condition above. Use ${SEED_OPT_IN} ` +
              "if you genuinely intend to seed this database, and remove " +
              "ALLOW_SEED_IN_PRODUCTION from wherever it is set.",
          ]
        : []),
    ].join("\n"),
  );
}

async function main() {
  assertSeedingIsIntended();

  // Say out loud what the opt-in just authorised. An operator who set the
  // variable for one database and then re-ran the command in another shell
  // should be able to see the target in their scrollback. Still no plaintext
  // password and no connection string: emails, counts and host/database only.
  const target = describeTarget();
  const adminCount = TEST_USERS.filter(({ role }) => role === "admin").length;
  console.warn(
    `[seed] ${SEED_OPT_IN}=true -- creating up to ${TEST_USERS.length} demo accounts ` +
      `(${adminCount} of them role "admin") that share one publicly known password` +
      `${target ? `, on ${target}` : ""}. This must never be a production database.`,
  );

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
      //  2. Its guard at the time was NODE_ENV === "production", which is
      //     unset in an ordinary dev shell AND in an operator's shell on the
      //     deployment host -- it is a container-only variable (Dockerfile:18),
      //     so the guard was inert wherever this script actually runs. `npm run
      //     db:seed` with DATABASE_URL pointed at any other database therefore
      //     silently REACTIVATED five accounts whose shared password is
      //     published at line 15 of this file -- including an admin.
      //     Reactivating a deliberately deactivated well-known-credential
      //     account is exactly the outcome Phase 7's offboarding feature exists
      //     to prevent. That inert guard has since been replaced by the
      //     fail-closed ALLOW_DEMO_SEED opt-in above, but this decision does
      //     not depend on it: an env-variable rail and a create-only script are
      //     independent layers, and a script that only ever CREATES cannot
      //     damage an existing row even if someone opts in against the wrong
      //     database.
      //
      // So this script now only ever CREATES. It never mutates a row it did not
      // create, which is the correct posture for a script whose outermost
      // safety rail is an environment variable a human has to set. The E2E
      // concern it was meant to solve is narrower than it looked: fresh
      // databases get the columns from `create` below, and a seed account that
      // someone deliberately deactivated during testing is now recoverable
      // through the product itself -- /admin/users
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
