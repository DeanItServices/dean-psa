import { randomBytes } from "node:crypto";
import { decode } from "next-auth/jwt";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  loginAs,
  loginExpectingFailure,
  loginWith,
  newIsolatedContext,
} from "./fixtures";
import {
  captureActionCall,
  invokeAction,
  retargetRoleChange,
  retargetUserId,
  type ActionCall,
} from "./actions";
import { E2E_EMAIL_DOMAIN, E2E_EMAIL_PREFIX, disconnectPrisma, envValue, prisma } from "./db";
import {
  confirmInAlertDialog,
  control,
  createUserViaUi as createUser,
  expectPathname,
  rowControl,
  rowUserId,
  selectRole,
  setNewPassword,
  userRow,
} from "./admin-users";
// Relative, not "@/lib/validations/user": the alias resolves through
// tsconfig's `paths`, and the runner's resolver is not the bundler's. A
// relative specifier cannot be wrong. The point is that the policy floor this
// spec asserts against is THE one the server enforces, not a 12 retyped here.
import { MIN_PASSWORD_LENGTH } from "../src/lib/validations/user";

/**
 * E2E spec: user lifecycle (Plan 07-07) -- the integration gate for Phase 7.
 *
 * Everything Phase 7 claims was, before this file, asserted only in plan
 * frontmatter and checked only with `grep -q` and `tsc`. Nothing in the phase
 * logged in, flipped a flag, or observed a redirect. This spec makes the
 * load-bearing claims executable:
 *
 *   - a created user is forced through /change-password before anything else
 *   - that force is a SERVER-ACTION boundary, not only a rendering redirect
 *   - a role change is authoritative on the very NEXT request, with no
 *     re-login and no change of session cookie (the JWT still carries the OLD
 *     role -- that is the entire point of 07-02's database fresh-check)
 *   - a password change or admin reset REVOKES every other session for that
 *     account (07-02's tokenVersion), while the acting device stays signed in
 *   - the change-password action requires the current password, and enforces
 *     the shared MIN_PASSWORD_LENGTH, on the server
 *   - a deactivated user's next request lands on /login, and the row survives
 *   - a deactivated user cannot log back in
 *   - a mixed-case email is normalized at creation, and a duplicate is refused
 *   - /admin/users is authorized server-side, and so is every action behind it
 *   - an admin cannot deactivate, demote or password-reset themselves, proven
 *     by calling the actions rather than by observing that the buttons look
 *     unavailable
 *
 * WHAT IS NOT HERE. The last-active-admin invariant is in
 * e2e/last-active-admin.spec.ts, in its own Playwright project, because it can
 * only be correct when no other spec is holding a second active admin open.
 *
 * TAG. Every test carries `@user-lifecycle` so this file can be run alone as
 * Phase 7's blocking gate:  npm run test:e2e -- --grep @user-lifecycle
 * The three pre-existing specs (tickets, sla-tracking, time-entry-to-invoice)
 * have never been executed against a browser and ROADMAP Phase 9 owns their
 * first real run and fixing what breaks; they are advisory evidence here, not
 * a Phase 7 gate.
 *
 * THE FIVE SEEDED FIXTURE ACCOUNTS ARE NEVER MUTATED. playwright.config.ts
 * sets `fullyParallel: true` against the shared dev database, so the other
 * three specs are logging in as admin@/dispatcher@/technician@mspdemo.local
 * WHILE this file runs. Deactivating, demoting or resetting any of them --
 * even transiently -- would break those specs for reasons having nothing to
 * do with what they test. Every subject account here is created by this spec
 * with a run-unique address and torn down in afterAll. That claim is now
 * CHECKED IN e2e/global-teardown.ts rather than by a test in this file: as a
 * test it was distributed across workers like any other and could run before
 * the mutations it was supposed to be guarding, which is no guard at all.
 *
 * Real, source-confirmed selectors (read from the components during this
 * review cycle, not guessed):
 *   - src/app/(dashboard)/admin/users/page.tsx: `<h1>Users</h1>`, card titles
 *     are `<h2>`; each row carries `data-testid="user-row-{email}"` and
 *     `data-active="{bool}"`, and the Name cell is a `<th scope="row">`
 *     (role `rowheader`).
 *   - src/components/admin/user-create-form.tsx: `#new-user-name`,
 *     `#new-user-email`, Radix Select trigger `#new-user-role`, submit button
 *     "Create user"; the one-time value is
 *     `[data-testid="temp-password-value"]` inside
 *     `[data-testid="temp-password-panel"]`, which is a `role="group"` that
 *     takes focus -- NOT a live region. The always-mounted live region is
 *     `[data-testid="temp-password-announcement"]`, and there is one PER ROW
 *     plus one in the create form, so it must always be row-scoped.
 *   - src/components/admin/user-row-actions.tsx: Radix Select trigger
 *     `#role-{userId}` and buttons whose ACCESSIBLE NAMES now carry the
 *     account they act on: "Change role for {email}", "Reset password for
 *     {email}", "Deactivate {email}", "Reactivate {email}". Destructive
 *     actions confirm through the styled ui/alert-dialog wrapper (never
 *     window.confirm); the buttons INSIDE those dialogs are unchanged, so the
 *     confirm control is still "Deactivate"/"Reset password" scoped to the
 *     open `alertdialog`.
 *   - Row controls are no longer `disabled`. They carry
 *     `aria-disabled="true"` and stay focusable, so `toBeDisabled()` does not
 *     apply -- see the self-target test.
 *   - src/app/(auth)/change-password/change-password-form.tsx:
 *     `#current-password` (NEW and required), `#new-password`,
 *     `#confirm-password`, button "Set new password".
 *   - /login and /change-password now have a `main` landmark and a real `h1`.
 */

// ---------------------------------------------------------------------------
// Run-scoped identity, database access and teardown
// ---------------------------------------------------------------------------

/**
 * Every account this file creates is addressed under this prefix, unique per
 * worker process per run. Teardown deletes by the EXACT addresses recorded in
 * `createdEmails` rather than by a `startsWith` sweep, so a concurrent run of
 * this same spec cannot delete another run's subjects. e2e/global-teardown.ts
 * adds a pattern sweep on top, for the rows a killed worker never reached.
 */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const EMAIL_PREFIX = `${E2E_EMAIL_PREFIX}${RUN_ID}`;

/** Addresses created through the UI during this run, in stored (lowercase) form. */
const createdEmails = new Set<string>();

function subjectEmail(label: string): string {
  return `${EMAIL_PREFIX}-${label}${E2E_EMAIL_DOMAIN}`;
}

/**
 * A password that clears MIN_PASSWORD_LENGTH with room to spare.
 *
 * GENERATED PER RUN, not a constant. The previous literal was a working
 * password for a live, active account whose address is derivable from this
 * file, committed in the repository, on an instance served over plaintext
 * HTTP. Teardown normally removes those accounts within seconds; a killed
 * worker does not, which is why e2e/global-teardown.ts sweeps as well. Between
 * the two, an orphan is now an account whose password exists only in a
 * finished process's memory.
 */
function freshPassword(label: string): string {
  const password = `e2e-${label}-${randomBytes(12).toString("base64url")}`;
  expect(
    password.length,
    "generated E2E passwords must clear the policy floor they are asserted against",
  ).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  return password;
}

/**
 * Reads a user's authoritative row.
 *
 * Used wherever the claim is about STORED state rather than rendered state.
 * "The self-target refusal did not take effect" has to be checked against the
 * row: a UI that merely failed to re-render would look identical to a server
 * that refused to write, and only one of those is the guarantee under test.
 */
async function readUserRow(email: string) {
  return prisma().user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      tokenVersion: true,
    },
  });
}

/**
 * TEARDOWN IS EXPLICIT, AND IT IS A DIRECT DATABASE DELETE.
 *
 * There is no user-deletion path anywhere in the application, by design:
 * 07-03 forbids `db.user.delete` in src/lib/actions/users.ts and 07-05 ships
 * no delete control, because offboarding is `isActive: false` and tickets,
 * comments and time entries carry billing history off those rows.
 * Deactivating a subject through the UI would therefore leave it in the
 * shared dev database forever, and every run of this spec would accrete
 * another handful of rows into /admin/users' listing.
 *
 * So teardown reaches past the application to Prisma. The subjects this spec
 * creates own no tickets, comments or time entries -- they never do anything
 * but sign in -- so the delete has no foreign key to violate. It is keyed on
 * the exact addresses recorded during the run, so it cannot touch a seeded
 * fixture or another run's rows even in principle.
 */
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
// Page-driving helpers
// ---------------------------------------------------------------------------

/**
 * Decodes the live Auth.js session cookie so its CLAIMS can be asserted.
 *
 * The session is a self-contained signed+encrypted JWT with no server-side
 * store (src/auth.ts explains why: Auth.js v5 rejects the database strategy
 * with a Credentials-only provider list). `role`, `id` and `tokenVersion` are
 * written into it by the jwt callback on the initial sign-in only, and never
 * refreshed -- which is exactly what makes it possible to prove a role change
 * took effect WITHOUT the token having been reissued.
 */
async function decodeSessionCookie(
  context: BrowserContext,
): Promise<{ id?: string; role?: string; tokenVersion?: number }> {
  const cookie = (await context.cookies()).find((candidate) =>
    candidate.name.includes("authjs.session-token"),
  );

  expect(cookie, "the subject must hold an Auth.js session cookie").toBeTruthy();

  const claims = await decode({
    token: cookie!.value,
    secret: envValue("AUTH_SECRET"),
    salt: cookie!.name,
  });

  expect(claims, "the session cookie must decode with AUTH_SECRET").toBeTruthy();

  const record = claims as unknown as Record<string, unknown>;
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    role: typeof record.role === "string" ? record.role : undefined,
    tokenVersion: typeof record.tokenVersion === "number" ? record.tokenVersion : undefined,
  };
}

/**
 * Creates a user through the real form AND records it for this run's teardown.
 *
 * The bookkeeping is what makes teardown exact-address-keyed rather than a
 * pattern sweep, so a concurrent run of this spec cannot delete another run's
 * subjects. createUserSchema lowercases before the action writes
 * (src/lib/validations/user.ts), so the STORED form is what is recorded.
 */
async function createUserViaUi(
  adminPage: Page,
  name: string,
  emailToType: string,
  roleLabel: string,
): Promise<{ tempPassword: string }> {
  const tempPassword = await createUser(adminPage, name, emailToType, roleLabel);
  createdEmails.add(emailToType.toLowerCase());
  return { tempPassword };
}

/**
 * Deactivates then reactivates `email` through the UI, and returns the
 * captured Server Action call for each.
 *
 * The capture is the point: the ids are per-build and are read off real
 * invocations (see e2e/actions.ts). Doing both leaves the victim exactly as it
 * was found, so a test can harvest the ids it needs without its arrange step
 * changing anything it later asserts on.
 */
async function captureLifecycleCalls(
  adminPage: Page,
  email: string,
): Promise<{ deactivate: ActionCall; reactivate: ActionCall }> {
  const row = userRow(adminPage, email);

  const deactivate = await captureActionCall(adminPage, async () => {
    await rowControl(adminPage, email, control.deactivate(email)).click();
    await confirmInAlertDialog(adminPage, "Deactivate");
    await expect(row).toHaveAttribute("data-active", "false");
  });

  const reactivate = await captureActionCall(adminPage, async () => {
    await rowControl(adminPage, email, control.reactivate(email)).click();
    await expect(row).toHaveAttribute("data-active", "true");
  });

  return { deactivate, reactivate };
}

// ---------------------------------------------------------------------------
// The lifecycle chain
// ---------------------------------------------------------------------------

/**
 * SERIAL, and deliberately so. This is one account's life told in order: it
 * cannot be forced to change a password it has already changed, and cannot be
 * reactivated before it is deactivated. Each step is its own named test so a
 * failure names the exact claim that broke rather than "the lifecycle test
 * failed", and the two long-lived browser contexts below let the subject's
 * session persist across steps -- the only way to observe that a role change
 * took effect WITHOUT a re-login.
 */
test.describe("@user-lifecycle account lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  const SUBJECT_EMAIL = subjectEmail("subject");
  const SUBJECT_NAME = "E2E Lifecycle Subject";
  const CHOSEN_PASSWORD = freshPassword("chosen");

  let adminContext: BrowserContext;
  let adminPage: Page;
  let subjectContext: BrowserContext;
  let subjectPage: Page;
  let tempPassword: string;
  let subjectId: string;

  test.beforeAll(async ({ browser }) => {
    adminContext = await newIsolatedContext(browser);
    adminPage = await adminContext.newPage();

    subjectContext = await newIsolatedContext(browser);
    subjectPage = await subjectContext.newPage();

    await loginAs(adminPage, "admin");
  });

  test.afterAll(async () => {
    await adminContext?.close();
    await subjectContext?.close();
  });

  test("an admin creates a user and the temporary password is shown exactly once", async () => {
    const created = await createUserViaUi(adminPage, SUBJECT_NAME, SUBJECT_EMAIL, "Technician");
    tempPassword = created.tempPassword;

    // 20 symbols drawn from the 32-symbol readable alphabet in
    // src/lib/actions/users.ts. Asserted so a future change that shortens the
    // value or widens it into ambiguous characters is caught here.
    expect(tempPassword).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{20}$/);

    const stored = await readUserRow(SUBJECT_EMAIL);
    expect(stored?.role).toBe("technician");
    expect(stored?.isActive).toBe(true);
    expect(stored?.mustChangePassword, "a new account must be forced to change its password").toBe(
      true,
    );
    subjectId = stored!.id;

    const row = userRow(adminPage, SUBJECT_EMAIL);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-active", "true");

    // The Name cell is a `<th scope="row">`, which is what gives a screen
    // reader the row's context when it reads the per-row controls. Asserted by
    // ROLE so a regression back to a plain `<td>` fails here rather than
    // silently removing the association.
    await expect(row.getByRole("rowheader")).toContainText(SUBJECT_NAME);

    // "Exactly once" is a load-bearing claim, not a caption: the value lives
    // in component state and nowhere else, so a reload must not bring it back
    // and it must not have been persisted anywhere retrievable.
    await adminPage.reload();
    await expect(adminPage.getByTestId("temp-password-panel")).toHaveCount(0);
    await expect(adminPage.getByText(tempPassword)).toHaveCount(0);
  });

  test("the new user logs in with the temporary password and is redirected to /change-password", async () => {
    await loginWith(subjectPage, SUBJECT_EMAIL, tempPassword, {
      expectPath: "/change-password",
    });

    // A real <h1> inside the (auth) layout's <main>, both added this cycle.
    await expect(
      subjectPage.getByRole("heading", { name: "Choose a new password", level: 1 }),
    ).toBeVisible();
    await expect(subjectPage.getByRole("main")).toBeVisible();
  });

  test("a flagged user is bounced from every dashboard route", async () => {
    // THIS IS THE UX GATE, AND ONLY THE UX GATE. The (dashboard) layout and
    // (since this cycle) each page's own requireActiveUser() perform this
    // redirect while rendering. The (dashboard) layout says so itself: its
    // redirect "is UX, NOT the security boundary". Deleting requireRole()'s
    // matching check would leave every assertion below passing.
    //
    // The boundary -- a Server Action refused for a caller carrying the flag
    // -- is asserted in "a flagged admin is refused at the Server Action
    // boundary" further down, which is the test that would fail.
    for (const route of ["/", "/tickets", "/clients", "/admin/users"]) {
      await subjectPage.goto(route);
      await expectPathname(subjectPage, "/change-password");
    }
  });

  test("setting a new password clears the flag, revokes older tokens, and keeps this device signed in", async () => {
    const before = await readUserRow(SUBJECT_EMAIL);

    await subjectPage.goto("/change-password");
    // The current password is REQUIRED now: an attacker riding a stolen
    // session holds the cookie but not the credential, and without this could
    // convert the session into a password of their own.
    await setNewPassword(subjectPage, tempPassword, CHOSEN_PASSWORD);

    await subjectPage.waitForURL((url) => url.pathname === "/");

    // ...and STAYS there. A client-side router.push proves nothing on its
    // own; a reload re-runs the (dashboard) layout's server-side gate against
    // the database, which is what actually had to change.
    await subjectPage.reload();
    await expectPathname(subjectPage, "/");
    // The dashboard itself rendered, not merely a redirect that stopped
    // happening. Matched by role because the account's display name appears
    // twice on this page (the greeting and the user menu).
    await expect(subjectPage.getByRole("heading", { name: /^Welcome back/ })).toBeVisible();

    const after = await readUserRow(SUBJECT_EMAIL);
    expect(after?.mustChangePassword).toBe(false);

    // The write bumped tokenVersion, which revokes every token minted before
    // it -- including the one this browser was holding one request ago. That
    // this device is still signed in (the reload above) is the action's
    // re-mint working; if the signIn() call after the update ever stops
    // happening, the reload lands on /login and this test names it.
    expect(
      after?.tokenVersion,
      "changePasswordAction must increment tokenVersion, or the change revokes nothing",
    ).toBe((before?.tokenVersion ?? 0) + 1);

    const claims = await decodeSessionCookie(subjectContext);
    expect(
      claims.tokenVersion,
      "the re-minted token must carry the NEW tokenVersion, or this device is running on a token the server should be refusing",
    ).toBe(after?.tokenVersion);
  });

  test("the flag is enforced by the page, not only by the layout, on a soft navigation", async () => {
    // WHAT THIS ISOLATES. Next.js does not re-render a shared layout on a
    // client-side navigation between two routes in the same group, so the
    // (dashboard) layout's gate does not run at all here. Group A added
    // requireActiveUser() to each page for exactly that hole: a user whose
    // flag is set while they are already browsing would otherwise keep
    // navigating the whole dashboard.
    //
    // The flag is set DIRECTLY IN THE DATABASE rather than through
    // resetUserPassword, deliberately: that action also increments
    // tokenVersion, which would revoke the session and send this user to
    // /login -- proving the revocation, not the page gate. This writes the one
    // field under test and nothing else.
    //
    // HONEST LIMIT: if a future Next.js did re-render the layout on this
    // navigation, this test would still pass while proving less. It is written
    // against the navigation shape the layout demonstrably does not cover.
    await subjectPage.goto("/");
    await expectPathname(subjectPage, "/");

    await prisma().user.update({
      where: { id: subjectId },
      data: { mustChangePassword: true },
    });

    await subjectPage.getByRole("link", { name: "Tickets", exact: true }).click();
    await expectPathname(subjectPage, "/change-password");

    await prisma().user.update({
      where: { id: subjectId },
      data: { mustChangePassword: false },
    });
  });

  test("a role change takes effect on the very next request, with no re-login", async () => {
    // Baseline: a technician is refused /admin/users server-side.
    await subjectPage.goto("/admin/users");
    await expectPathname(subjectPage, "/unauthorized");

    // The admin promotes them, from a different browser context entirely.
    await adminPage.goto("/admin/users");
    await selectRole(adminPage, `role-${subjectId}`, "Admin");
    await rowControl(adminPage, SUBJECT_EMAIL, control.changeRole(SUBJECT_EMAIL)).click();
    await expect.poll(async () => (await readUserRow(SUBJECT_EMAIL))?.role).toBe("admin");

    // THE HEADLINE CLAIM. No sign-out, no sign-in, no new cookie -- the JWT
    // in this context still carries `role: "technician"`. The database is
    // authoritative (07-02's getCurrentUser fresh-check), so the very next
    // request is authorized on the NEW role.
    await subjectPage.goto("/admin/users");
    await expectPathname(subjectPage, "/admin/users");
    await expect(subjectPage.getByRole("heading", { name: "Users", exact: true })).toBeVisible();

    // AND THE JWT IS PROVABLY STALE. Decoding the live session cookie shows
    // the `role` claim still says "technician" -- src/auth.ts's jwt callback
    // writes it only on the initial sign-in and never refreshes it. So the
    // request above was authorized as an admin by a token that says the
    // caller is a technician, which is precisely 07-02's claim: the JWT
    // identifies, the database authorizes.
    //
    // Comparing raw cookie VALUES would prove nothing here -- Auth.js
    // re-encrypts the JWE on each response, so the string differs every
    // request even when the claims are identical. Observed directly during
    // this plan before this assertion was written.
    const claims = await decodeSessionCookie(subjectContext);
    expect(
      claims.role,
      "the session token must still carry the OLD role, or this proves re-authentication rather than freshness",
    ).toBe("technician");
    expect(claims.id).toBe(subjectId);

    // And it revokes in the other direction too, which is the half that
    // matters for offboarding. Demoting this subject is safe with respect to
    // the last-active-admin guard rail: the seeded admin is still active, so
    // the invariant is not engaged.
    await adminPage.goto("/admin/users");
    await selectRole(adminPage, `role-${subjectId}`, "Technician");
    await rowControl(adminPage, SUBJECT_EMAIL, control.changeRole(SUBJECT_EMAIL)).click();
    await expect.poll(async () => (await readUserRow(SUBJECT_EMAIL))?.role).toBe("technician");

    await subjectPage.goto("/admin/users");
    await expectPathname(subjectPage, "/unauthorized");
  });

  test("deactivation lands the user's next request on /login and does not delete the row", async () => {
    await subjectPage.goto("/");
    await expectPathname(subjectPage, "/");

    await adminPage.goto("/admin/users");
    await rowControl(adminPage, SUBJECT_EMAIL, control.deactivate(SUBJECT_EMAIL)).click();
    await confirmInAlertDialog(adminPage, "Deactivate");
    await expect(userRow(adminPage, SUBJECT_EMAIL)).toHaveAttribute("data-active", "false");

    // Still holding a valid, unexpired session cookie -- and still refused.
    await subjectPage.goto("/");
    await expectPathname(subjectPage, "/login");

    const stored = await readUserRow(SUBJECT_EMAIL);
    expect(stored, "deactivation must NOT delete the row -- billing history hangs off it").not.toBeNull();
    expect(stored?.isActive).toBe(false);
  });

  test("a deactivated user cannot log in", async () => {
    // NARROWED THIS CYCLE, and the removal matters more than what is left.
    // This test used to also assert that a deactivated login and a
    // wrong-password login produce the SAME message, captioned as proof the
    // form does not enumerate accounts. That assertion could not fail:
    // loginAction (src/app/(auth)/login/actions.ts) catches every AuthError
    // and returns that one literal, so both sides of the comparison are the
    // same constant no matter what authorize() does -- including if it started
    // returning a distinct "account disabled" error. Proving authorize()
    // itself is uniform belongs in a unit test on that function, and is
    // referred to Phase 9 rather than faked here.
    //
    // What remains is a real claim: the credential is correct and the login is
    // refused anyway, because the account is deactivated.
    const message = await loginExpectingFailure(subjectPage, SUBJECT_EMAIL, CHOSEN_PASSWORD);
    await expectPathname(subjectPage, "/login");
    expect(message).toBe("Invalid email or password");
  });

  test("reactivation restores access with the user's existing password", async () => {
    await adminPage.goto("/admin/users");
    await rowControl(adminPage, SUBJECT_EMAIL, control.reactivate(SUBJECT_EMAIL)).click();
    await expect(userRow(adminPage, SUBJECT_EMAIL)).toHaveAttribute("data-active", "true");

    // Reactivation is not a password reset -- the password they chose still
    // works, and they are not sent back through /change-password.
    await loginWith(subjectPage, SUBJECT_EMAIL, CHOSEN_PASSWORD, { expectPath: "/" });
    await expectPathname(subjectPage, "/");

    const stored = await readUserRow(SUBJECT_EMAIL);
    expect(stored?.isActive).toBe(true);
    expect(stored?.mustChangePassword).toBe(false);
  });

  test("an admin password reset revokes the user's live session and forces /change-password", async () => {
    const before = await readUserRow(SUBJECT_EMAIL);

    await adminPage.goto("/admin/users");
    await rowControl(adminPage, SUBJECT_EMAIL, control.resetPassword(SUBJECT_EMAIL)).click();
    await confirmInAlertDialog(adminPage, "Reset password");

    // Row-scoped: `temp-password-panel` exists in the create form too, and
    // `temp-password-announcement` exists once per row PLUS once in the create
    // form, so anything unscoped trips Playwright's strict mode.
    const row = userRow(adminPage, SUBJECT_EMAIL);
    const panel = row.getByTestId("temp-password-panel");
    await expect(panel).toBeVisible();
    const reissued = ((await panel.getByTestId("temp-password-value").textContent()) ?? "").trim();

    expect(reissued).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{20}$/);
    expect(reissued, "a reset must issue a NEW value, not re-show the old one").not.toBe(
      tempPassword,
    );

    // THE REVOCATION. The subject's browser is holding a valid, unexpired
    // session cookie minted before the reset. Rotating the password hash alone
    // would not touch it -- the JWT never re-checks the hash -- so before
    // tokenVersion existed, an attacker riding a stolen session survived the
    // reset untouched and could walk to /change-password and set a password of
    // their own. Their very next request must now land on /login.
    const after = await readUserRow(SUBJECT_EMAIL);
    expect(after?.tokenVersion).toBe((before?.tokenVersion ?? 0) + 1);

    await subjectPage.goto("/");
    await expectPathname(subjectPage, "/login");

    // The old password stops working immediately -- the confirmation dialog
    // promises exactly this, so it is asserted rather than assumed.
    const refused = await loginExpectingFailure(subjectPage, SUBJECT_EMAIL, CHOSEN_PASSWORD);
    expect(refused).toBe("Invalid email or password");

    // The reissued one works, and drops them straight back into the forced
    // password change -- resetUserPassword sets mustChangePassword.
    expect(after?.mustChangePassword).toBe(true);
    await loginWith(subjectPage, SUBJECT_EMAIL, reissued, { expectPath: "/change-password" });
    await expect(
      subjectPage.getByRole("heading", { name: "Choose a new password", level: 1 }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Email normalization and duplicates
// ---------------------------------------------------------------------------

test("@user-lifecycle a mixed-case email is normalized so the account is actually reachable", async ({
  browser,
}) => {
  const typedEmail = `E2E-Lifecycle-${RUN_ID}-MiXeD${E2E_EMAIL_DOMAIN.toUpperCase()}`;
  const storedEmail = typedEmail.toLowerCase();

  const adminContext = await newIsolatedContext(browser);
  const adminPage = await adminContext.newPage();
  const subjectContext = await newIsolatedContext(browser);
  const subjectPage = await subjectContext.newPage();

  try {
    await loginAs(adminPage, "admin");

    const { tempPassword } = await createUserViaUi(
      adminPage,
      "E2E Mixed Case",
      typedEmail,
      "Technician",
    );

    // The bug class 07-03 names: authorize() looks the account up with
    // `email.toLowerCase()` (src/auth.ts), so a row stored with any uppercase
    // character is PERMANENTLY unreachable, and the failure is
    // indistinguishable from a wrong password -- the admin who created the
    // account gets no signal at all.
    expect((await readUserRow(storedEmail))?.email).toBe(storedEmail);
    await expect(userRow(adminPage, storedEmail)).toBeVisible();

    // And it is reachable typing the address the way the admin typed it,
    // which is the way it will be handed to the new user.
    await loginWith(subjectPage, typedEmail, tempPassword, { expectPath: "/change-password" });
    await expect(
      subjectPage.getByRole("heading", { name: "Choose a new password", level: 1 }),
    ).toBeVisible();
  } finally {
    await adminContext.close();
    await subjectContext.close();
  }
});

test("@user-lifecycle a duplicate email is refused, including a case-only duplicate", async ({
  browser,
}) => {
  const email = subjectEmail("dup");

  const adminContext = await newIsolatedContext(browser);
  const adminPage = await adminContext.newPage();

  try {
    await loginAs(adminPage, "admin");
    await createUserViaUi(adminPage, "E2E Duplicate First", email, "Technician");

    // Typed in a DIFFERENT case, which is the case that matters: the schema
    // lowercases before the write, so this collides on the unique index
    // (Prisma P2002) rather than creating a second row that authorize() could
    // never reach. Without the normalization this would "succeed" and hand the
    // admin a temporary password for an account that can never be logged into.
    await adminPage.goto("/admin/users");
    await adminPage.locator("#new-user-name").fill("E2E Duplicate Second");
    await adminPage.locator("#new-user-email").fill(email.toUpperCase());
    await adminPage.getByRole("button", { name: "Create user" }).click();

    await expect(adminPage.locator("#create-user-error")).toHaveText(
      "An account with that email address already exists.",
    );
    // No credential was issued for the refused attempt.
    await expect(adminPage.getByTestId("temp-password-panel")).toHaveCount(0);

    expect(
      await prisma().user.count({
        where: { email: { startsWith: `${EMAIL_PREFIX}-dup`, endsWith: E2E_EMAIL_DOMAIN } },
      }),
      "the refused create must not have written a second row",
    ).toBe(1);
  } finally {
    await adminContext.close();
  }
});

// ---------------------------------------------------------------------------
// Admin-only gating -- the page AND the actions behind it
// ---------------------------------------------------------------------------

test("@user-lifecycle /admin/users and its Server Actions are authorized server-side, not merely hidden", async ({
  browser,
}) => {
  test.setTimeout(90_000);

  const victimEmail = subjectEmail("gating-victim");

  const adminContext = await newIsolatedContext(browser);
  const adminPage = await adminContext.newPage();
  const techContext = await newIsolatedContext(browser);
  const techPage = await techContext.newPage();

  try {
    await loginAs(adminPage, "admin");
    await createUserViaUi(adminPage, "E2E Gating Victim", victimEmail, "Technician");
    await adminPage.goto("/admin/users");
    const victimId = await rowUserId(adminPage, victimEmail);
    const { deactivate } = await captureLifecycleCalls(adminPage, victimEmail);

    // Uses the seeded technician read-only, exactly as the other three specs
    // do. Nothing about this account is mutated.
    await loginAs(techPage, "technician");

    // The sidebar link is gated on admin:manage_users so a technician never
    // sees it -- but 07-05's own must_have says hiding the link is not
    // authorization. Type the URL directly.
    await expect(techPage.getByRole("link", { name: "Users", exact: true })).toHaveCount(0);

    await techPage.goto("/admin/users");
    await expectPathname(techPage, "/unauthorized");
    await expect(techPage.getByText("Access Denied")).toBeVisible();
    await expect(techPage.getByRole("heading", { name: "Users", exact: true })).toHaveCount(0);

    // AND THE ACTION ITSELF. Being unable to reach the page is not the same as
    // being unable to reach what the page calls: the Server Action has a
    // stable, publicly-addressable id and needs no page to invoke. Sent with
    // the technician's own cookies, it must be refused by requireRole().
    const response = await invokeAction(
      techContext,
      "/admin/users",
      deactivate,
      retargetUserId(deactivate, victimId),
    );

    expect(
      response.redirectedTo,
      "a technician invoking deactivateUser must be redirected by requireRole(), not served",
    ).toBe("/unauthorized");
    expect(response.result, "the action must not have returned a result to a technician").toBeNull();
    expect(
      (await readUserRow(victimEmail))?.isActive,
      "the refused action must not have written",
    ).toBe(true);
  } finally {
    await adminContext.close();
    await techContext.close();
  }
});

// ---------------------------------------------------------------------------
// The mustChangePassword boundary
// ---------------------------------------------------------------------------

test("@user-lifecycle a flagged admin is refused at the Server Action boundary and at the QBO routes", async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const flaggedEmail = subjectEmail("flagged-admin");
  const victimEmail = subjectEmail("flagged-victim");

  const adminContext = await newIsolatedContext(browser);
  const adminPage = await adminContext.newPage();
  const flaggedContext = await newIsolatedContext(browser);
  const flaggedPage = await flaggedContext.newPage();

  try {
    // THE ACTOR IS AN ADMIN, and that is what makes this test say anything.
    // requireRole() checks the ROLE before it checks the flag, so a flagged
    // technician is refused for being a technician and the flag is never
    // reached. Only a caller who would otherwise be authorized isolates
    // mustChangePassword as the reason.
    await loginAs(adminPage, "admin");
    await createUserViaUi(adminPage, "E2E Flagged Victim", victimEmail, "Technician");
    const { tempPassword } = await createUserViaUi(
      adminPage,
      "E2E Flagged Admin",
      flaggedEmail,
      "Admin",
    );

    await adminPage.goto("/admin/users");
    const victimId = await rowUserId(adminPage, victimEmail);
    const { deactivate } = await captureLifecycleCalls(adminPage, victimEmail);

    // The flagged admin signs in and is parked on /change-password. Their
    // password is never changed, so the flag stays set for everything below.
    await loginWith(flaggedPage, flaggedEmail, tempPassword, { expectPath: "/change-password" });

    // (1) THE ACTUAL BOUNDARY. This is the assertion the old criterion-9 test
    // did not make. Navigating to dashboard routes and seeing /change-password
    // exercises the (dashboard) layout, whose own comment says that redirect
    // "is UX, NOT the security boundary" -- delete requireRole()'s flag check
    // and that test still passes. This one does not: it invokes the Server
    // Action directly, with the flagged admin's own session, and the refusal
    // can only come from requireRole().
    const refused = await invokeAction(
      flaggedContext,
      "/admin/users",
      deactivate,
      retargetUserId(deactivate, victimId),
    );

    expect(
      refused.redirectedTo,
      "requireRole() must bounce a flagged caller to /change-password before the action runs",
    ).toBe("/change-password");
    expect(refused.result, "the action must not have returned a result").toBeNull();
    expect(
      (await readUserRow(victimEmail))?.isActive,
      "the refused action must not have written",
    ).toBe(true);

    // (2) /api/qbo/connect. Verified by grep only until now, and never once
    // executed. It is a Route Handler, so it cannot call requireRole() (that
    // helper throws next/navigation's redirect digest, which this pipeline
    // does not intercept) and repeats the gate by hand -- which is exactly the
    // kind of hand-copied check that rots without a test.
    const connect = await flaggedContext.request.get("/api/qbo/connect", { maxRedirects: 0 });
    expect(connect.status(), "/api/qbo/connect must redirect a flagged admin").toBe(307);
    expect(new URL(connect.headers()["location"]!).pathname).toBe("/change-password");

    // (3) /api/qbo/callback, which gained the same gate this cycle. Reached
    // with no code/state at all: the flag check must come BEFORE the OAuth
    // state validation, or a flagged caller gets a state_mismatch redirect
    // instead of being refused, and the gate is decorative.
    const callback = await flaggedContext.request.get("/api/qbo/callback", { maxRedirects: 0 });
    expect(callback.status(), "/api/qbo/callback must redirect a flagged admin").toBe(307);
    expect(new URL(callback.headers()["location"]!).pathname).toBe("/change-password");
  } finally {
    await adminContext.close();
    await flaggedContext.close();
  }
});

// ---------------------------------------------------------------------------
// Self-target refusals
// ---------------------------------------------------------------------------

/**
 * The acting admin here is an admin this spec CREATES, never the seeded
 * admin@mspdemo.local.
 *
 * That is a safety property, not a stylistic one. This test deliberately
 * reaches past the client-side guards to the server-side refusals. If one of
 * those refusals were missing -- precisely what the test exists to detect --
 * the action would SUCCEED, and pointed at the seeded admin it would
 * deactivate or demote the account all three other specs log in as, mid-run,
 * under `fullyParallel: true`. Pointed at a throwaway admin, a genuine product
 * bug fails this test loudly and damages nothing.
 *
 * Creating a second admin is also harmless with respect to the
 * last-active-admin invariant, which is a floor: it can only ever be moved
 * further from firing, never closer. (It is not harmless to
 * e2e/last-active-admin.spec.ts, which needs the opposite -- hence that spec's
 * own project, which runs only after this one has finished and torn down.)
 */
test("@user-lifecycle an admin cannot deactivate, demote or password-reset themselves", async ({
  browser,
}) => {
  // Provisions a whole second admin through the real UI (create, first login,
  // forced password change) plus a throwaway victim before it can begin. That
  // does not fit Playwright's 30s default, and the default is not a claim
  // about the product.
  test.setTimeout(150_000);

  const selfAdminEmail = subjectEmail("selfadmin");
  const victimEmail = subjectEmail("self-victim");
  const actorPassword = freshPassword("selfadmin");

  const seedContext = await newIsolatedContext(browser);
  const seedPage = await seedContext.newPage();
  const actorContext = await newIsolatedContext(browser);
  const actorPage = await actorContext.newPage();

  try {
    // Arrange: the seeded admin creates a second admin, who is the ACTOR for
    // everything that follows, plus a victim the actor can legitimately act on
    // -- which is how the per-build Server Action ids are captured.
    await loginAs(seedPage, "admin");
    await createUserViaUi(seedPage, "E2E Self Target Victim", victimEmail, "Technician");
    const { tempPassword } = await createUserViaUi(
      seedPage,
      "E2E Self Target Admin",
      selfAdminEmail,
      "Admin",
    );

    await loginWith(actorPage, selfAdminEmail, tempPassword, { expectPath: "/change-password" });
    await setNewPassword(actorPage, tempPassword, actorPassword);
    await actorPage.waitForURL((actorUrl) => actorUrl.pathname === "/");

    const actorId = (await readUserRow(selfAdminEmail))?.id;
    expect(actorId).toBeTruthy();

    await actorPage.goto("/admin/users");
    const ownRow = userRow(actorPage, selfAdminEmail);
    await expect(ownRow).toBeVisible();
    await expect(ownRow).toContainText("(you)");

    // LAYER 1 -- the UX an admin actually experiences, and it is no longer
    // `disabled`. The controls stay focusable and carry aria-disabled, because
    // `disabled` dropped focus to <body> mid-flow and took the explanation
    // below out of the tab order entirely. toBeDisabled() would now fail
    // against a correct implementation, so the attribute is asserted directly.
    for (const name of [
      control.changeRole(selfAdminEmail),
      control.resetPassword(selfAdminEmail),
      control.deactivate(selfAdminEmail),
    ]) {
      await expect(
        ownRow.getByRole("button", { name, exact: true }),
        `${name} must be blocked with aria-disabled, not the disabled attribute`,
      ).toHaveAttribute("aria-disabled", "true");
    }
    await expect(ownRow).toContainText("This is your own account.");

    // ...and they are still FOCUSABLE, which is the whole point of the change:
    // `disabled` takes a control out of the tab order, so the explanation
    // above was text nobody arriving by keyboard would ever reach. Focus is
    // moved by script rather than by locator.focus() so this assertion cannot
    // itself depend on Playwright's actionability rules.
    for (const name of [
      control.changeRole(selfAdminEmail),
      control.resetPassword(selfAdminEmail),
      control.deactivate(selfAdminEmail),
    ]) {
      const focused = await ownRow
        .getByRole("button", { name, exact: true })
        .evaluate((node) => {
          (node as HTMLElement).focus();
          return document.activeElement === node;
        });
      expect(focused, `${name} must stay in the tab order`).toBe(true);
    }

    // ...and the block is real, not just announced: clicking does nothing.
    //
    // `force: true` is REQUIRED here and is not papering over flakiness.
    // Playwright's actionability check for "enabled" calls its own
    // getAriaDisabled(), which treats aria-disabled="true" on a button role as
    // disabled -- so a plain .click() waits for the control to become enabled
    // and hangs until the test times out. Read out of the installed
    // playwright-core rather than guessed, after exactly that timeout. A
    // browser places no such restriction on a real user, so forcing the click
    // is the faithful simulation and the unforced one is the fiction.
    await ownRow
      .getByRole("button", { name: control.deactivate(selfAdminEmail), exact: true })
      .click({ force: true });
    await expect(
      actorPage.getByRole("alertdialog"),
      "a blocked trigger must not open its confirmation dialog",
    ).toHaveCount(0);

    // LAYER 2 -- THE GUARANTEE. Everything above is client-side, and 07-05
    // says so itself: the row component "contains no authorization logic". The
    // refusals in src/lib/actions/users.ts are the boundary, and a boundary
    // with no regression test is one that can be deleted by accident. The
    // actions are therefore invoked directly, with the actor's own session,
    // targeting the actor -- the exact request the browser would send if the
    // client-side guard were removed.
    //
    // The previous version of this test drove the React fiber's onClick past a
    // `disabled` attribute. That technique now invokes a handler that returns
    // early, so it would have proved the client guard and reported it as the
    // server one.
    const victimId = await rowUserId(actorPage, victimEmail);
    const { deactivate, reactivate } = await captureLifecycleCalls(actorPage, victimEmail);

    const resetCall = await captureActionCall(actorPage, async () => {
      await rowControl(actorPage, victimEmail, control.resetPassword(victimEmail)).click();
      await confirmInAlertDialog(actorPage, "Reset password");
      await expect(
        userRow(actorPage, victimEmail).getByTestId("temp-password-panel"),
      ).toBeVisible();
    });

    const roleCall = await captureActionCall(actorPage, async () => {
      await selectRole(actorPage, `role-${victimId}`, "Sales");
      await rowControl(actorPage, victimEmail, control.changeRole(victimEmail)).click();
      await expect.poll(async () => (await readUserRow(victimEmail))?.role).toBe("sales");
    });

    // (a) Reset password.
    const reset = await invokeAction(
      actorContext,
      "/admin/users",
      resetCall,
      retargetUserId(resetCall, actorId!),
    );
    expect(reset.result?.error).toContain("You cannot reset your own password here");
    expect(reset.result?.tempPassword, "no credential may be issued by a refused reset").toBeUndefined();

    // (b) Deactivate.
    const deactivated = await invokeAction(
      actorContext,
      "/admin/users",
      deactivate,
      retargetUserId(deactivate, actorId!),
    );
    expect(deactivated.result?.error).toContain("You cannot deactivate your own account");

    // (c) Demote -- WITH A GENUINELY DIFFERENT ROLE. The previous version
    // submitted "admin" for an admin actor, because the Radix Select on one's
    // own row cannot be opened; nothing was actually being lowered, so a
    // regression that narrowed the guard to same-role submissions would have
    // left real self-demotion possible and this test green. retargetRoleChange
    // asserts the substitution reached the wire.
    const demoted = await invokeAction(
      actorContext,
      "/admin/users",
      roleCall,
      retargetRoleChange(roleCall, actorId!, "technician"),
    );
    expect(demoted.result?.error).toContain("You cannot change your own role");

    // The response is the rendering; this is the record. A server that
    // returned an error string while still writing would be indistinguishable
    // from one that refused.
    const stored = await readUserRow(selfAdminEmail);
    expect(stored?.isActive, "self-deactivation must not have taken effect").toBe(true);
    expect(stored?.role, "self-demotion must not have taken effect").toBe("admin");
    expect(stored?.mustChangePassword, "self password-reset must not have taken effect").toBe(
      false,
    );

    // The actor is still authorized, which is the point of all three guard
    // rails: an admin must not be able to lock themselves out mid-session.
    await actorPage.goto("/admin/users");
    await expectPathname(actorPage, "/admin/users");

    // AND THE SAME ACTIONS STILL WORK ON SOMEONE ELSE, so the three refusals
    // above are the self-target guard rails and not a blanket failure that
    // would pass this test for the wrong reason.
    const other = await invokeAction(
      actorContext,
      "/admin/users",
      reactivate,
      retargetUserId(reactivate, victimId),
    );
    expect(other.result?.success, "the actor must still be able to act on OTHER accounts").toBe(
      true,
    );
  } finally {
    await seedContext.close();
    await actorContext.close();
  }
});

// ---------------------------------------------------------------------------
// Server-side validation the browser will not let you submit
// ---------------------------------------------------------------------------

test("@user-lifecycle the change-password action enforces its own floors, not the browser's", async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const email = subjectEmail("changepw");
  const chosen = freshPassword("changepw");

  const adminContext = await newIsolatedContext(browser);
  const adminPage = await adminContext.newPage();
  const subjectContext = await newIsolatedContext(browser);
  const subjectPage = await subjectContext.newPage();

  try {
    await loginAs(adminPage, "admin");
    const { tempPassword } = await createUserViaUi(adminPage, "E2E Change PW", email, "Technician");
    await loginWith(subjectPage, email, tempPassword, { expectPath: "/change-password" });

    // (1) THE WRONG CURRENT PASSWORD IS REFUSED. This is the check that stops
    // an attacker riding a stolen session from converting it into a password
    // of their own -- they hold the cookie but not the credential. Driven
    // through the real form, and the request it produces is captured so the
    // remaining cases can be sent directly.
    const call = await captureActionCall(subjectPage, async () => {
      await setNewPassword(subjectPage, `${tempPassword}-wrong`, chosen);
      await expect(subjectPage.locator("#change-password-error")).toHaveText(
        "Current password is incorrect.",
      );
    });
    expect(
      (await readUserRow(email))?.mustChangePassword,
      "a refused change must leave the flag set",
    ).toBe(true);

    // (2) NO CURRENT PASSWORD AT ALL. The form marks the field `required`, so
    // the browser will not submit it -- which means the server-side refusal is
    // unreachable from the UI and would rot unnoticed. The parameter is typed
    // optional (so the fix could land before the form did) and is required at
    // runtime; this is the assertion that keeps that true.
    const omitted = await invokeAction(
      subjectContext,
      "/change-password",
      call,
      JSON.stringify([chosen, chosen]),
    );
    expect(omitted.result?.error).toBe("Enter your current password.");

    // (3) BELOW THE POLICY FLOOR. `minLength` on the input is the browser's
    // opinion; MIN_PASSWORD_LENGTH in src/lib/validations/user.ts is the
    // server's, and it is imported here rather than restated so a change to
    // the policy cannot leave this test asserting the old number.
    const tooShort = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    const short = await invokeAction(
      subjectContext,
      "/change-password",
      call,
      JSON.stringify([tooShort, tooShort, { currentPassword: tempPassword }]),
    );
    expect(short.result?.error).toBe(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );

    // (4) MISMATCHED CONFIRMATION.
    const mismatch = await invokeAction(
      subjectContext,
      "/change-password",
      call,
      JSON.stringify([chosen, `${chosen}x`, { currentPassword: tempPassword }]),
    );
    expect(mismatch.result?.error).toBe("Passwords do not match.");

    // (5) RE-SETTING THE TEMPORARY PASSWORD IS REFUSED. Allowing it would
    // clear mustChangePassword while leaving the admin-issued credential in
    // place -- the exact outcome this page exists to prevent, and the one an
    // impatient user would reach for.
    const reuse = await invokeAction(
      subjectContext,
      "/change-password",
      call,
      JSON.stringify([tempPassword, tempPassword, { currentPassword: tempPassword }]),
    );
    expect(reuse.result?.error).toBe("Choose a password different from your current one.");

    // Nothing above changed anything.
    const stillFlagged = await readUserRow(email);
    expect(stillFlagged?.mustChangePassword).toBe(true);

    // And the honest path still works, from the same page, through the form.
    await subjectPage.goto("/change-password");
    await setNewPassword(subjectPage, tempPassword, chosen);
    await subjectPage.waitForURL((url) => url.pathname === "/");
    expect((await readUserRow(email))?.mustChangePassword).toBe(false);
  } finally {
    await adminContext.close();
    await subjectContext.close();
  }
});

// ---------------------------------------------------------------------------
// tokenVersion revocation, across two live sessions
// ---------------------------------------------------------------------------

test("@user-lifecycle changing a password revokes the account's OTHER live sessions", async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const email = subjectEmail("revoke");
  const first = freshPassword("revoke-1");
  const second = freshPassword("revoke-2");

  const adminContext = await newIsolatedContext(browser);
  const adminPage = await adminContext.newPage();
  // Two independent browser contexts for ONE account: the device the user is
  // sitting at, and the session an attacker is riding.
  const deviceContext = await newIsolatedContext(browser);
  const devicePage = await deviceContext.newPage();
  const otherContext = await newIsolatedContext(browser);
  const otherPage = await otherContext.newPage();

  try {
    await loginAs(adminPage, "admin");
    const { tempPassword } = await createUserViaUi(adminPage, "E2E Revoke", email, "Technician");

    // Both sessions start from the same credential and the same tokenVersion.
    await loginWith(devicePage, email, tempPassword, { expectPath: "/change-password" });
    await setNewPassword(devicePage, tempPassword, first);
    await devicePage.waitForURL((url) => url.pathname === "/");

    await loginWith(otherPage, email, first, { expectPath: "/" });
    const otherClaims = await decodeSessionCookie(otherContext);
    const deviceClaims = await decodeSessionCookie(deviceContext);
    expect(
      otherClaims.tokenVersion,
      "both sessions must start on the same generation, or this proves nothing",
    ).toBe(deviceClaims.tokenVersion);

    // The user changes their password on their own device.
    await devicePage.goto("/change-password");
    await setNewPassword(devicePage, first, second);
    await devicePage.waitForURL((url) => url.pathname === "/");

    // Their own device stays signed in -- the action re-mints a token from the
    // password they just chose.
    await devicePage.reload();
    await expectPathname(devicePage, "/");

    // The other session is dead on its very next request, holding a cookie
    // that is still perfectly valid, unexpired and correctly signed. Only the
    // tokenVersion check refuses it.
    await otherPage.goto("/tickets");
    await expectPathname(otherPage, "/login");

    // ...and it cannot be revived with the old password either.
    const refused = await loginExpectingFailure(otherPage, email, first);
    expect(refused).toBe("Invalid email or password");
  } finally {
    await adminContext.close();
    await deviceContext.close();
    await otherContext.close();
  }
});

// ---------------------------------------------------------------------------
// Missing-row handling
// ---------------------------------------------------------------------------

test("@user-lifecycle reactivateUser refuses an id that does not exist", async ({ browser }) => {
  const email = subjectEmail("p2025");

  const adminContext = await newIsolatedContext(browser);
  const adminPage = await adminContext.newPage();

  try {
    await loginAs(adminPage, "admin");
    await createUserViaUi(adminPage, "E2E P2025", email, "Technician");
    await adminPage.goto("/admin/users");
    const { reactivate } = await captureLifecycleCalls(adminPage, email);

    // A user deleted by another admin between the page render and the click is
    // the ordinary race here, and Prisma raises P2025 for it. The action must
    // turn that into a message, not a 500 -- and the branch is unreachable
    // through the UI, which only ever offers ids that were on the page.
    const response = await invokeAction(
      adminContext,
      "/admin/users",
      reactivate,
      retargetUserId(reactivate, "e2e-id-that-does-not-exist"),
    );

    expect(response.result?.error).toBe("User not found");
    expect(response.status, "a missing row must not be a server error").toBe(200);
  } finally {
    await adminContext.close();
  }
});

// ---------------------------------------------------------------------------
// The seeded fixtures
// ---------------------------------------------------------------------------
//
// "The five seeded fixture accounts are untouched" USED TO BE A TEST HERE, and
// it has moved to e2e/global-teardown.ts. Under `fullyParallel: true` a test
// cannot be last: Playwright distributes tests across workers, so the guard ran
// before or during the mutations it was supposed to catch. The global teardown
// genuinely runs after every worker, compares against a baseline recorded in
// global setup rather than against a hardcoded expectation, and runs even when
// a worker was killed. ROLE_CREDENTIALS is still the list of accounts involved;
// e2e/db.ts's SEEDED_FIXTURES is the list of those accounts and the role the
// seed gives each of them.
