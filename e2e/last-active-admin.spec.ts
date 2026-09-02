import { test, expect } from "@playwright/test";
import { loginAs, loginWith, newIsolatedContext } from "./fixtures";
import {
  confirmInAlertDialog,
  control,
  createUserViaUi,
  expectPathname,
  rowControl,
  selectRole,
  setNewPassword,
  rowUserId,
  userRow,
} from "./admin-users";
import { E2E_EMAIL_DOMAIN, E2E_EMAIL_PREFIX, disconnectPrisma, prisma } from "./db";

/**
 * THE LAST-ACTIVE-ADMIN INVARIANT, EXECUTED.
 *
 * WHAT THIS REPLACES. Plan 07-07 marked this guard rail "demonstrated" on the
 * strength of a manual transcript that (a) SIMULATED the count rather than
 * calling the action and (b) showed a concurrency run in which a different
 * mechanism -- the advisory lock's contention path -- is what stopped the
 * loser. The branch itself, `return { error: LAST_ADMIN_ERROR }` in
 * src/lib/actions/users.ts, had never executed. A guard rail nothing has ever
 * triggered is a guard rail nobody knows the shape of.
 *
 * WHY IT LOOKS UNREACHABLE, AND WHY IT IS NOT.
 *
 * Both call sites count OTHER active admins and refuse at zero:
 *
 *   countOtherActiveAdmins(tx, id) =
 *     role: "admin", isActive: true, hashedPassword: { not: null }, id != target
 *
 * The actor is excluded from nothing -- only the TARGET is -- and the actor
 * must themselves be an active admin to have passed requireRole(). Both
 * actions also refuse a self-target before they ever count. So single-threaded,
 * with every admin holding a password, the count includes the actor and can
 * never be zero: the branch is unsatisfiable. That is exactly why it had never
 * run, and why "just write a test for it" had not worked.
 *
 * The way in is the clause Group A added this cycle, `hashedPassword: { not:
 * null }`. The column is nullable, and authorize() (src/auth.ts) refuses any
 * row without a hash -- so an admin with no password is an admin who can never
 * sign in, and counting them would let this guard rail report "another admin
 * remains" while deactivating the last admin who can ACTUALLY log in. This spec
 * puts the actor in precisely that state: a real admin, created and signed in
 * through the UI, whose credential is then removed. Their live session keeps
 * working (getCurrentUser reads role/isActive/tokenVersion, never the hash), so
 * they are still authorized to act -- and they no longer count. With the seeded
 * admin as the target, the count reaches zero and the branch runs.
 *
 * The state is not contrived, either: it is the exact state the new clause was
 * added for.
 *
 * WHY THE TARGET IS THE SEEDED ADMIN, WHICH THIS SUITE OTHERWISE NEVER TOUCHES.
 * There is no alternative, and it is worth being explicit rather than quiet
 * about it. To reach zero, every qualifying admin other than the target must be
 * non-qualifying; admin@mspdemo.local always qualifies, so it must BE the
 * target. Four things make that safe:
 *
 *   1. The action is expected to REFUSE, so nothing is written. That is the
 *      claim under test.
 *   2. The precondition is asserted BEFORE the attempt. If any other admin
 *      could still log in, the guard rail correctly would not fire and the
 *      attempt would SUCCEED -- so the test fails loudly at the precondition
 *      instead of deactivating the account three other specs sign in as. This
 *      is not hypothetical: it happened while this spec was being written,
 *      against admins a previous run had orphaned.
 *   3. This spec is its own Playwright project, `dependencies: ["lifecycle"]`
 *      and `fullyParallel: false`, so it starts only after the lifecycle spec
 *      has finished and torn down the second admins it creates.
 *   4. The seeded admin's row is snapshotted and restored in a `finally`,
 *      unconditionally, as a backstop for the case the guard rail is actually
 *      broken.
 *
 * Tagged @user-lifecycle so Phase 7's gate run includes it.
 */

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const SEEDED_ADMIN_EMAIL = "admin@mspdemo.local";

/** Mirrors LAST_ADMIN_ERROR in src/lib/actions/users.ts, which is module-private. */
const LAST_ADMIN_ERROR =
  "This is the last active admin. Promote or reactivate another admin first, otherwise nobody would be able to administer the system.";

function subjectEmail(label: string): string {
  return `${E2E_EMAIL_PREFIX}${RUN_ID}-${label}${E2E_EMAIL_DOMAIN}`;
}

test("@user-lifecycle the last active admin cannot be deactivated or demoted", async ({
  browser,
}) => {
  // Provisions an admin through the real UI (create, first login, forced
  // password change) and a victim, then drives two refusals.
  test.setTimeout(150_000);

  const actorEmail = subjectEmail("lastadmin-actor");
  const victimEmail = subjectEmail("lastadmin-victim");
  const actorPassword = `e2e-lastadmin-${RUN_ID}-Chosen`;
  const created: string[] = [];

  const seedContext = await newIsolatedContext(browser);
  const seedPage = await seedContext.newPage();
  const actorContext = await newIsolatedContext(browser);
  const actorPage = await actorContext.newPage();

  // Snapshot FIRST, so the restore in `finally` is meaningful even if the
  // arrange steps below throw halfway through.
  const seededAdminBefore = await prisma().user.findUnique({
    where: { email: SEEDED_ADMIN_EMAIL },
    select: { id: true, role: true, isActive: true },
  });
  expect(seededAdminBefore, `the seeded admin ${SEEDED_ADMIN_EMAIL} must exist`).not.toBeNull();

  try {
    // --- Arrange: a real, working second admin, plus a harmless victim -----
    await loginAs(seedPage, "admin");

    await createUserViaUi(seedPage, "E2E Last Admin Victim", victimEmail, "Technician");
    created.push(victimEmail);

    const tempPassword = await createUserViaUi(
      seedPage,
      "E2E Last Admin Actor",
      actorEmail,
      "Admin",
    );
    created.push(actorEmail);

    await loginWith(actorPage, actorEmail, tempPassword, { expectPath: "/change-password" });
    await setNewPassword(actorPage, tempPassword, actorPassword);
    await actorPage.waitForURL((url) => url.pathname === "/");

    const actor = await prisma().user.findUnique({
      where: { email: actorEmail },
      select: { id: true },
    });
    expect(actor?.id).toBeTruthy();

    // --- Arrange: make the actor an admin who can no longer sign in -------
    // Their session survives -- getCurrentUser() never loads hashedPassword --
    // so they stay authorized to act while dropping out of the count.
    await prisma().user.update({
      where: { id: actor!.id },
      data: { hashedPassword: null },
    });

    // --- THE PRECONDITION, asserted before anything destructive is tried ---
    const otherQualifyingAdmins = await prisma().user.count({
      where: {
        role: "admin",
        isActive: true,
        hashedPassword: { not: null },
        id: { notIn: [seededAdminBefore!.id, actor!.id] },
      },
    });
    expect(
      otherQualifyingAdmins,
      [
        "This test attempts to deactivate and demote the seeded admin, relying on the",
        "last-active-admin guard rail to refuse. That guard rail only fires when no OTHER",
        "admin could still log in. Another qualifying admin exists right now, so the",
        "attempt would SUCCEED and take out the account the other specs sign in as.",
        "Refusing to proceed. The usual cause is an orphaned e2e admin from a killed run",
        "(e2e/global-setup.ts sweeps those) or another spec running concurrently (this",
        "spec's project depends on `lifecycle` precisely so that cannot happen).",
      ].join(" "),
    ).toBe(0);

    // --- Act (1): deactivating the last active admin ----------------------
    await actorPage.goto("/admin/users");
    await expect(actorPage.getByRole("heading", { name: "Users", exact: true })).toBeVisible();

    const seededRow = userRow(actorPage, SEEDED_ADMIN_EMAIL);
    await rowControl(
      actorPage,
      SEEDED_ADMIN_EMAIL,
      control.deactivate(SEEDED_ADMIN_EMAIL),
    ).click();
    await confirmInAlertDialog(actorPage, "Deactivate");

    const alert = seededRow.getByRole("alert");
    await expect(alert, "deactivateUser must refuse and say why").toHaveText(LAST_ADMIN_ERROR);
    await expect(seededRow).toHaveAttribute("data-active", "true");

    expect(
      (
        await prisma().user.findUnique({
          where: { id: seededAdminBefore!.id },
          select: { isActive: true },
        })
      )?.isActive,
      "the refusal must be a refusal to WRITE, not merely a message",
    ).toBe(true);

    // --- Act (2): demoting the last active admin --------------------------
    // A separate branch, in a separate action (updateUserRole), reached only
    // when an ACTIVE admin is losing the admin role.
    const seededAdminId = await rowUserId(actorPage, SEEDED_ADMIN_EMAIL);
    await selectRole(actorPage, `role-${seededAdminId}`, "Technician");
    await rowControl(
      actorPage,
      SEEDED_ADMIN_EMAIL,
      control.changeRole(SEEDED_ADMIN_EMAIL),
    ).click();

    await expect(alert, "updateUserRole must refuse and say why").toHaveText(LAST_ADMIN_ERROR);

    expect(
      (
        await prisma().user.findUnique({
          where: { id: seededAdminBefore!.id },
          select: { role: true },
        })
      )?.role,
      "the refusal must be a refusal to WRITE, not merely a message",
    ).toBe("admin");

    // --- Control: the actor is not simply broken --------------------------
    // Both refusals above would look identical if this admin could no longer
    // do anything at all. They can: the same two actions still work on an
    // account whose loss would not empty the admin population.
    await actorPage.goto("/admin/users");
    await rowControl(actorPage, victimEmail, control.deactivate(victimEmail)).click();
    await confirmInAlertDialog(actorPage, "Deactivate");
    await expect(userRow(actorPage, victimEmail)).toHaveAttribute("data-active", "false");
    await expectPathname(actorPage, "/admin/users");
  } finally {
    // Backstop. If the guard rail is genuinely broken, the assertions above
    // have already failed -- but the seeded admin must not be left damaged for
    // every other spec and every later run.
    if (seededAdminBefore) {
      await prisma().user.update({
        where: { id: seededAdminBefore.id },
        data: { role: seededAdminBefore.role, isActive: seededAdminBefore.isActive },
      });
    }
    if (created.length > 0) {
      await prisma().user.deleteMany({ where: { email: { in: created } } });
    }
    await disconnectPrisma();
    await seedContext.close();
    await actorContext.close();
  }
});
