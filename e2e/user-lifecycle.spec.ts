import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { decode } from "next-auth/jwt";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { loginAs, loginWith, loginExpectingFailure, ROLE_CREDENTIALS } from "./fixtures";

/**
 * E2E spec: user lifecycle (Plan 07-07) -- the integration gate for Phase 7.
 *
 * Everything Phase 7 claims was, before this file, asserted only in plan
 * frontmatter and checked only with `grep -q` and `tsc`. Nothing in the phase
 * logged in, flipped a flag, or observed a redirect. This spec makes the
 * load-bearing claims executable:
 *
 *   - a created user is forced through /change-password before anything else
 *   - a role change is authoritative on the very NEXT request, with no
 *     re-login and no change of session cookie (the JWT still carries the OLD
 *     role -- that is the entire point of 07-02's database fresh-check)
 *   - a deactivated user's next request lands on /login, and the row survives
 *   - a deactivated user cannot log back in, and cannot tell that apart from
 *     a wrong password
 *   - a mixed-case email is normalized at creation, so the account is
 *     actually reachable by authorize()'s lowercased lookup
 *   - /admin/users is authorized server-side, not merely hidden from the nav
 *   - an admin cannot deactivate, demote or password-reset themselves
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
 * with a run-unique address and torn down in afterAll; the seeded accounts
 * are used read-only as login actors, exactly as the other specs use them,
 * and the last test in this file asserts they were left as found.
 *
 * Real, source-confirmed selectors (read from the components during this
 * plan's execution, not guessed):
 *   - src/app/(dashboard)/admin/users/page.tsx: `<h1>Users</h1>`; each row
 *     carries `data-testid="user-row-{email}"` and `data-active="{bool}"`.
 *   - src/components/admin/user-create-form.tsx: `#new-user-name`,
 *     `#new-user-email`, Radix Select trigger `#new-user-role`, submit button
 *     "Create user"; the one-time value is
 *     `[data-testid="temp-password-value"]` inside
 *     `[data-testid="temp-password-panel"]`.
 *   - src/components/admin/user-row-actions.tsx: Radix Select trigger
 *     `#role-{userId}` and buttons "Change role" / "Reset password" /
 *     "Deactivate" / "Reactivate"; destructive actions confirm through the
 *     styled ui/alert-dialog wrapper (never window.confirm), so the confirm
 *     control is a button scoped to the open `alertdialog`.
 *   - src/app/(auth)/change-password/change-password-form.tsx:
 *     `#new-password`, `#confirm-password`, button "Set new password".
 *   - `CardTitle` (src/components/ui/card.tsx) renders a plain `<div>`, NOT a
 *     heading, so "Choose a new password" and "Access Denied" are matched by
 *     text rather than by role. Verified by reading the component after a
 *     getByRole("heading") assertion failed against the real page.
 */

// ---------------------------------------------------------------------------
// Run-scoped identity, database access and teardown
// ---------------------------------------------------------------------------

/**
 * Every account this file creates is addressed under this prefix, unique per
 * worker process per run. Teardown deletes by the EXACT addresses recorded in
 * `createdEmails` rather than by a `startsWith` sweep, so a concurrent run of
 * this same spec cannot delete another run's subjects.
 */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const EMAIL_PREFIX = `e2e-lifecycle-${RUN_ID}`;

/** Addresses created through the UI during this run, in stored (lowercase) form. */
const createdEmails = new Set<string>();

function subjectEmail(label: string): string {
  return `${EMAIL_PREFIX}-${label}@e2e.invalid`;
}

/**
 * A password that clears MIN_PASSWORD_LENGTH (12, src/lib/validations/user.ts)
 * with room to spare. Deliberately NOT the seeded fixtures' "Password123!" --
 * these throwaway accounts must not double as a way into anything else.
 */
const CHOSEN_PASSWORD = "e2e-Chosen-Password-9134";

/**
 * DATABASE_URL for the assertions that read stored state.
 *
 * The Playwright runner process is not `next dev` and loads no dotenv of its
 * own, so `.env` is read here explicitly rather than assumed to be in the
 * environment. Parsed with a few lines rather than by pulling in `dotenv`,
 * which is present only transitively via Prisma and is not a declared
 * dependency of this project.
 */
function envValue(name: string): string {
  const fromProcess = process.env[name];
  if (fromProcess) {
    return fromProcess;
  }

  const envPath = path.resolve(process.cwd(), ".env");
  const contents = readFileSync(envPath, "utf8");

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== name) continue;

    return line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }

  throw new Error(
    `${name} is not set and was not found in ${envPath}. ` +
      "This spec needs it to read stored state back, decode the session token, " +
      "and tear down the accounts it creates.",
  );
}

function databaseUrl(): string {
  return envValue("DATABASE_URL");
}

let prismaClient: PrismaClient | null = null;

function prisma(): PrismaClient {
  prismaClient ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl() }),
  });
  return prismaClient;
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
    select: { id: true, email: true, role: true, isActive: true, mustChangePassword: true },
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
    await prismaClient?.$disconnect();
    prismaClient = null;
  }
});

// ---------------------------------------------------------------------------
// Page-driving helpers (the real UI only -- no Server Action is called
// over the wire, and no spec here fabricates an affordance that does not
// exist)
// ---------------------------------------------------------------------------

function baseURL(): string {
  const configured = test.info().project.use.baseURL;
  if (!configured) {
    throw new Error("playwright.config.ts must define use.baseURL");
  }
  return configured;
}

/**
 * Per-context client IP, sent as X-Forwarded-For.
 *
 * NOT a convenience, and not masking a failure this spec should be reporting.
 * src/middleware.ts rate-limits 60 requests per 60 seconds PER IP, and its
 * `getClientIp()` falls back to the literal key "unknown" when no
 * X-Forwarded-For or X-Real-IP header is present. With no reverse proxy in
 * front of the app -- the topology this repo's docker-compose.yml ships, as
 * middleware.ts itself documents at length -- every browser context in every
 * spec therefore shares ONE 60-request budget.
 *
 * Measured directly during this plan: 60 consecutive requests to
 * /unauthorized returned 307, and requests 61 through 75 returned 429. A
 * Server Action POST that receives a 429 rejects in the browser, and 07-05's
 * handlers turn that into "Something went wrong. Please try again." -- which
 * is exactly the failure this spec hit before these headers were added, and
 * it is indistinguishable from a genuine guard-rail bug at the assertion.
 *
 * Giving each context its own address is what a correctly-deployed reverse
 * proxy would produce anyway (distinct clients, distinct buckets), and it
 * keeps this spec testing the user lifecycle rather than the rate limiter.
 * The shared-bucket behaviour itself is a real finding referred to the owner
 * of src/middleware.ts -- see this plan's summary. Addresses come from the
 * RFC 2544 benchmarking range, which is not routable.
 */
const IP_BASE = Math.floor(Math.random() * 250) + 1;
let ipCounter = 0;

function isolatedClientHeaders(): Record<string, string> {
  ipCounter += 1;
  return { "x-forwarded-for": `198.18.${IP_BASE}.${ipCounter}` };
}

/** A browser context with its own rate-limit bucket and the configured baseURL. */
async function newIsolatedContext(
  browser: import("@playwright/test").Browser,
): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: baseURL(),
    extraHTTPHeaders: isolatedClientHeaders(),
  });
}

/**
 * Decodes the live Auth.js session cookie so its CLAIMS can be asserted.
 *
 * The session is a self-contained signed+encrypted JWT with no server-side
 * store (src/auth.ts explains why: Auth.js v5 rejects the database strategy
 * with a Credentials-only provider list). `role` and `id` are written into it
 * by the jwt callback on the initial sign-in only, and never refreshed --
 * which is exactly what makes it possible to prove a role change took effect
 * WITHOUT the token having been reissued.
 */
async function decodeSessionCookie(
  context: BrowserContext,
): Promise<{ id?: string; role?: string }> {
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
  };
}

/** Asserts the current pathname, retrying while a redirect settles. */
async function expectPathname(page: Page, pathname: string): Promise<void> {
  await expect
    .poll(() => new URL(page.url()).pathname, {
      message: `expected to be on ${pathname}`,
    })
    .toBe(pathname);
}

/** Picks a value in a Radix Select by its trigger id. */
async function selectRole(page: Page, triggerId: string, label: string): Promise<void> {
  await page.locator(`#${triggerId}`).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

/**
 * Creates a user through the real /admin/users form and returns the one-time
 * temporary password the panel shows.
 *
 * `emailToType` is passed verbatim so the normalization test can type an
 * address that is not its own stored form.
 */
async function createUserViaUi(
  adminPage: Page,
  name: string,
  emailToType: string,
  roleLabel: string,
): Promise<{ tempPassword: string }> {
  await adminPage.goto("/admin/users");

  await adminPage.locator("#new-user-name").fill(name);
  await adminPage.locator("#new-user-email").fill(emailToType);
  await selectRole(adminPage, "new-user-role", roleLabel);
  await adminPage.getByRole("button", { name: "Create user" }).click();

  const panel = adminPage.getByTestId("temp-password-panel");
  await expect(panel).toBeVisible();

  const tempPassword = (await adminPage.getByTestId("temp-password-value").textContent())?.trim();
  expect(tempPassword, "the create form must surface a temporary password").toBeTruthy();

  // Recorded for teardown in the STORED form: createUserSchema lowercases
  // before the action writes (src/lib/validations/user.ts).
  createdEmails.add(emailToType.toLowerCase());

  return { tempPassword: tempPassword as string };
}

function userRow(adminPage: Page, email: string) {
  return adminPage.getByTestId(`user-row-${email}`);
}

/**
 * Confirms a destructive row action through the alert dialog.
 *
 * 07-05 deliberately uses the styled ui/alert-dialog wrapper rather than
 * window.confirm precisely so this is drivable from a locator. The confirm
 * button is scoped to the open `alertdialog` so it cannot match the row's own
 * trigger button of the same name.
 */
async function confirmInAlertDialog(page: Page, buttonName: string): Promise<void> {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: buttonName, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Fires a control's React onClick handler even though the control is
 * `disabled`, and fails loudly if it cannot.
 *
 * WHY THIS IS THE TEST RATHER THAN A WORKAROUND FOR ONE.
 * 07-05 disables the three self-target controls client-side and says in its
 * own summary that this "is UX only -- the server refusal is the guarantee".
 * A spec that only asserted the buttons are disabled would prove the UX and
 * prove nothing whatsoever about the guarantee -- which is exactly the
 * "hiding a control is not authorization" failure mode this phase exists to
 * close. The refusals in src/lib/actions/users.ts are the real boundary, and
 * a boundary with no regression test is a boundary that can be deleted by
 * accident.
 *
 * WHY IT REACHES FOR REACT'S PROPS INSTEAD OF JUST CLICKING.
 * Established empirically during this plan, not assumed. Removing the DOM
 * `disabled` attribute is NOT sufficient: React's synthetic event system
 * suppresses onClick for a form control whose *fiber props* carry
 * `disabled: true`, independently of the DOM attribute. A probe against the
 * running app confirmed all three steps -- after hydration the element's
 * `__reactProps$*` bag reports `disabled: "true"`, a real Playwright click
 * with the attribute stripped opens nothing, and invoking the handler off
 * that same props bag does open the dialog. Radix's Select trigger is
 * unreachable by any of these routes (it re-checks `disabled` internally),
 * which is why the demotion attempt below submits the role already selected.
 *
 * WHAT IT COSTS. A dependency on React's internal `__reactProps$` key. If a
 * future React changes that, this throws a named error rather than silently
 * passing -- the one failure mode that would be unacceptable here.
 */
async function invokeOnce(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((el) => {
    const propsKey = Object.keys(el).find((key) => key.startsWith("__reactProps$"));

    if (!propsKey) {
      return "NOT_HYDRATED";
    }

    const props = (el as unknown as Record<string, Record<string, unknown>>)[propsKey];
    const onClick = props.onClick;

    if (typeof onClick !== "function") {
      return "NO_ONCLICK_PROP";
    }

    (onClick as (event: unknown) => void)({
      type: "click",
      button: 0,
      ctrlKey: false,
      currentTarget: el,
      target: el,
      defaultPrevented: false,
      preventDefault() {},
      stopPropagation() {},
      nativeEvent: new MouseEvent("click"),
    });

    return "INVOKED";
  });
}

/**
 * Invokes a disabled control's handler until `settled()` reports the intended
 * effect, or fails with the reason it could not.
 *
 * The retry is not papering over flakiness in the assertion -- the assertion
 * is untouched and still has to hold. It exists because `__reactProps$`
 * appears on the DOM node slightly BEFORE React has mounted the component,
 * and a handler invoked in that window logs "Can't perform a React state
 * update on a component that hasn't mounted yet" and does nothing. Observed
 * directly during this plan; retrying rides out that window instead of
 * guessing a sleep long enough to cover it.
 */
async function invokeDisabledControl(
  page: Page,
  selector: string,
  settled: () => Promise<boolean>,
): Promise<void> {
  await expect
    .poll(
      async () => {
        if (await settled()) return "SETTLED";

        const outcome = await invokeOnce(page, selector);
        if (outcome !== "INVOKED") return outcome;

        await page.waitForTimeout(250);
        return (await settled()) ? "SETTLED" : "PENDING";
      },
      {
        timeout: 20_000,
        message:
          `could not drive the disabled control ${selector} to its effect. ` +
          "This spec pushes the self-target refusals past 07-05's client-side `disabled` " +
          "attributes to prove the SERVER refuses them. A result of NO_ONCLICK_PROP or " +
          "NOT_HYDRATED means the technique needs revisiting -- do not delete the " +
          "assertions it guards.",
      },
    )
    .toBe("SETTLED");
}

/**
 * Blocks until React on /admin/users is genuinely mounted and handling
 * events, proven by driving a control rather than by waiting a fixed time:
 * the create form's role Select is opened and dismissed. Radix only opens it
 * once its handlers are live.
 */
async function waitForAdminUsersInteractive(page: Page): Promise<void> {
  const option = page.getByRole("option", { name: "Technician", exact: true });

  await page.locator("#new-user-role").click();
  await expect(option).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(option).toHaveCount(0);
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

    await expect(subjectPage.getByText("Choose a new password")).toBeVisible();
  });

  test("a flagged user cannot reach any dashboard route", async () => {
    // requireRole() enforces the flag for every Server Action module and the
    // (dashboard) layout enforces it for rendering, so no authenticated
    // surface is reachable while it is set. Before 07-02 this was a rendering
    // gate only.
    for (const route of ["/", "/tickets", "/clients", "/admin/users"]) {
      await subjectPage.goto(route);
      await expectPathname(subjectPage, "/change-password");
    }
  });

  test("setting a new password clears the flag and lands the user on /", async () => {
    await subjectPage.goto("/change-password");
    await subjectPage.locator("#new-password").fill(CHOSEN_PASSWORD);
    await subjectPage.locator("#confirm-password").fill(CHOSEN_PASSWORD);
    await subjectPage.getByRole("button", { name: "Set new password" }).click();

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

    expect((await readUserRow(SUBJECT_EMAIL))?.mustChangePassword).toBe(false);
  });

  test("a role change takes effect on the very next request, with no re-login", async () => {
    // Baseline: a technician is refused /admin/users server-side.
    await subjectPage.goto("/admin/users");
    await expectPathname(subjectPage, "/unauthorized");

    // The admin promotes them, from a different browser context entirely.
    await adminPage.goto("/admin/users");
    await selectRole(adminPage, `role-${subjectId}`, "Admin");
    await userRow(adminPage, SUBJECT_EMAIL)
      .getByRole("button", { name: "Change role", exact: true })
      .click();
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
    await userRow(adminPage, SUBJECT_EMAIL)
      .getByRole("button", { name: "Change role", exact: true })
      .click();
    await expect.poll(async () => (await readUserRow(SUBJECT_EMAIL))?.role).toBe("technician");

    await subjectPage.goto("/admin/users");
    await expectPathname(subjectPage, "/unauthorized");
  });

  test("deactivation lands the user's next request on /login and does not delete the row", async () => {
    await subjectPage.goto("/");
    await expectPathname(subjectPage, "/");

    await adminPage.goto("/admin/users");
    await userRow(adminPage, SUBJECT_EMAIL)
      .getByRole("button", { name: "Deactivate", exact: true })
      .click();
    await confirmInAlertDialog(adminPage, "Deactivate");
    await expect(userRow(adminPage, SUBJECT_EMAIL)).toHaveAttribute("data-active", "false");

    // Still holding a valid, unexpired session cookie -- and still refused.
    await subjectPage.goto("/");
    await expectPathname(subjectPage, "/login");

    const stored = await readUserRow(SUBJECT_EMAIL);
    expect(stored, "deactivation must NOT delete the row -- billing history hangs off it").not.toBeNull();
    expect(stored?.isActive).toBe(false);
  });

  test("a deactivated user cannot log in, and cannot tell that apart from a wrong password", async () => {
    const deactivatedMessage = await loginExpectingFailure(
      subjectPage,
      SUBJECT_EMAIL,
      CHOSEN_PASSWORD,
    );
    await expectPathname(subjectPage, "/login");

    const wrongPasswordMessage = await loginExpectingFailure(
      subjectPage,
      SUBJECT_EMAIL,
      `${CHOSEN_PASSWORD}-definitely-wrong`,
    );

    expect(deactivatedMessage).toBe("Invalid email or password");
    expect(
      deactivatedMessage,
      "a deactivated account must be indistinguishable from a wrong password, or the login form enumerates accounts",
    ).toBe(wrongPasswordMessage);
  });

  test("reactivation restores access with the user's existing password", async () => {
    await adminPage.goto("/admin/users");
    await userRow(adminPage, SUBJECT_EMAIL)
      .getByRole("button", { name: "Reactivate", exact: true })
      .click();
    await expect(userRow(adminPage, SUBJECT_EMAIL)).toHaveAttribute("data-active", "true");

    // Reactivation is not a password reset -- the password they chose still
    // works, and they are not sent back through /change-password.
    await loginWith(subjectPage, SUBJECT_EMAIL, CHOSEN_PASSWORD, { expectPath: "/" });
    await expectPathname(subjectPage, "/");

    const stored = await readUserRow(SUBJECT_EMAIL);
    expect(stored?.isActive).toBe(true);
    expect(stored?.mustChangePassword).toBe(false);
  });

  test("an admin resets another user's password and the user is forced through /change-password again", async () => {
    await adminPage.goto("/admin/users");
    const row = userRow(adminPage, SUBJECT_EMAIL);
    await row.getByRole("button", { name: "Reset password", exact: true }).click();
    await confirmInAlertDialog(adminPage, "Reset password");

    const panel = row.getByTestId("temp-password-panel");
    await expect(panel).toBeVisible();
    const reissued = ((await row.getByTestId("temp-password-value").textContent()) ?? "").trim();

    expect(reissued).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{20}$/);
    expect(reissued, "a reset must issue a NEW value, not re-show the old one").not.toBe(
      tempPassword,
    );

    // The old password stops working immediately -- the confirmation dialog
    // promises exactly this, so it is asserted rather than assumed.
    const refused = await loginExpectingFailure(subjectPage, SUBJECT_EMAIL, CHOSEN_PASSWORD);
    expect(refused).toBe("Invalid email or password");

    // The reissued one works, and drops them straight back into the forced
    // password change -- resetUserPassword sets mustChangePassword.
    expect((await readUserRow(SUBJECT_EMAIL))?.mustChangePassword).toBe(true);
    await loginWith(subjectPage, SUBJECT_EMAIL, reissued, { expectPath: "/change-password" });
    await expect(subjectPage.getByText("Choose a new password")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Email normalization
// ---------------------------------------------------------------------------

test("@user-lifecycle a mixed-case email is normalized so the account is actually reachable", async ({
  browser,
}) => {
  const typedEmail = `E2E-Lifecycle-${RUN_ID}-MiXeD@E2E.Invalid`;
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
    await expect(subjectPage.getByText("Choose a new password")).toBeVisible();
  } finally {
    await adminContext.close();
    await subjectContext.close();
  }
});

// ---------------------------------------------------------------------------
// Admin-only gating
// ---------------------------------------------------------------------------

test("@user-lifecycle /admin/users is authorized server-side, not merely hidden from the nav", async ({
  browser,
}) => {
  const context = await newIsolatedContext(browser);
  const page = await context.newPage();

  try {
    // Uses the seeded technician read-only, exactly as the other three specs
    // do. Nothing about this account is mutated.
    await loginAs(page, "technician");

    // The sidebar link is gated on admin:manage_users so a technician never
    // sees it -- but 07-05's own must_have says hiding the link is not
    // authorization. Type the URL directly.
    await expect(page.getByRole("link", { name: "Users", exact: true })).toHaveCount(0);

    await page.goto("/admin/users");
    await expectPathname(page, "/unauthorized");
    await expect(page.getByText("Access Denied")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toHaveCount(0);
  } finally {
    await context.close();
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
 * drives past the client-side `disabled` attributes to reach the server-side
 * refusals. If one of those refusals were missing -- precisely what the test
 * exists to detect -- the action would SUCCEED, and pointed at the seeded
 * admin it would deactivate or demote the account all three other specs log
 * in as, mid-run, under `fullyParallel: true`. Pointed at a throwaway admin,
 * a genuine product bug fails this test loudly and damages nothing.
 *
 * Creating a second admin is also harmless with respect to the
 * last-active-admin invariant, which is a floor: it can only ever be moved
 * further from firing, never closer.
 */
test("@user-lifecycle an admin cannot deactivate, demote or password-reset themselves", async ({
  browser,
}) => {
  // This test provisions a whole second admin through the real UI (create,
  // first login, forced password change) before it can even begin, then drives
  // three refusals with a retry budget on each. That does not fit Playwright's
  // 30s default, and the default is not a claim about the product.
  test.setTimeout(120_000);

  const selfAdminEmail = subjectEmail("selfadmin");

  const seedContext = await newIsolatedContext(browser);
  const seedPage = await seedContext.newPage();
  const actorContext = await newIsolatedContext(browser);
  const actorPage = await actorContext.newPage();

  try {
    // Arrange: the seeded admin creates a second admin, who is the ACTOR for
    // everything that follows.
    await loginAs(seedPage, "admin");
    const { tempPassword } = await createUserViaUi(
      seedPage,
      "E2E Self Target Admin",
      selfAdminEmail,
      "Admin",
    );

    await loginWith(actorPage, selfAdminEmail, tempPassword, { expectPath: "/change-password" });
    await actorPage.locator("#new-password").fill(CHOSEN_PASSWORD);
    await actorPage.locator("#confirm-password").fill(CHOSEN_PASSWORD);
    await actorPage.getByRole("button", { name: "Set new password" }).click();
    await actorPage.waitForURL((actorUrl) => actorUrl.pathname === "/");

    const actorId = (await readUserRow(selfAdminEmail))?.id;
    expect(actorId).toBeTruthy();

    await actorPage.goto("/admin/users");
    const rowSelector = `[data-testid="user-row-${selfAdminEmail}"]`;
    const ownRow = userRow(actorPage, selfAdminEmail);
    await expect(ownRow).toBeVisible();
    await expect(ownRow).toContainText("(you)");

    // LAYER 1 -- the UX an admin actually experiences. All three controls are
    // disabled, with the reason stated on the row.
    await expect(ownRow.getByRole("button", { name: "Change role", exact: true })).toBeDisabled();
    await expect(ownRow.getByRole("button", { name: "Reset password", exact: true })).toBeDisabled();
    await expect(ownRow.getByRole("button", { name: "Deactivate", exact: true })).toBeDisabled();
    await expect(ownRow).toContainText("This is your own account.");

    const alert = ownRow.getByRole("alert");
    const dialogOpen = () => actorPage.getByRole("alertdialog").isVisible();

    // LAYER 2 -- the guarantee. Drive each action anyway; the server must
    // refuse, say so visibly, and change nothing.
    await waitForAdminUsersInteractive(actorPage);

    // (a) Reset password.
    await invokeDisabledControl(
      actorPage,
      `${rowSelector} button:has-text("Reset password")`,
      dialogOpen,
    );
    await confirmInAlertDialog(actorPage, "Reset password");
    await expect(alert).toContainText("You cannot reset your own password here");
    await expect(actorPage.getByTestId("temp-password-panel")).toHaveCount(0);

    // (b) Deactivate.
    await invokeDisabledControl(
      actorPage,
      `${rowSelector} button:has-text("Deactivate")`,
      dialogOpen,
    );
    await confirmInAlertDialog(actorPage, "Deactivate");
    await expect(alert).toContainText("You cannot deactivate your own account");
    await expect(ownRow).toHaveAttribute("data-active", "true");

    // (c) Demote. The role Select on one's own row cannot be opened by any
    // client-side route (Radix re-checks `disabled` inside its own handlers,
    // verified by probe), so the submitted role is necessarily the one
    // already selected -- "admin". That still exercises the guard rail under
    // test: updateUserRole refuses on `id === actor.id` BEFORE it parses or
    // looks at the role at all (src/lib/actions/users.ts), so the refusal
    // reached here is the self-target refusal and nothing else.
    await invokeDisabledControl(
      actorPage,
      `${rowSelector} button:has-text("Change role")`,
      async () => ((await alert.textContent()) ?? "").includes("You cannot change your own role"),
    );
    await expect(alert).toContainText("You cannot change your own role");

    // The row is the rendering; this is the record. A UI that merely failed
    // to re-render would be indistinguishable from a server that refused.
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
  } finally {
    await seedContext.close();
    await actorContext.close();
  }
});

// ---------------------------------------------------------------------------
// The seeded fixtures are left exactly as they were found
// ---------------------------------------------------------------------------

/**
 * A guard, not a feature test.
 *
 * This spec runs concurrently with three others that log in as these five
 * accounts. If anything here ever mutated one of them, the resulting failures
 * would surface somewhere else entirely, in a spec with nothing to do with
 * Phase 7. Naming the invariant here attributes the breakage where it
 * belongs.
 */
test("@user-lifecycle the five seeded fixture accounts are untouched", async () => {
  for (const { email } of Object.values(ROLE_CREDENTIALS)) {
    const row = await readUserRow(email);
    expect(row, `seeded fixture ${email} must exist`).not.toBeNull();
    expect(row?.isActive, `seeded fixture ${email} must still be active`).toBe(true);
    expect(
      row?.mustChangePassword,
      `seeded fixture ${email} must not be flagged for password change`,
    ).toBe(false);
  }
});
