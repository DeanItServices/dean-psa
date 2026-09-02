import { expect, type Page } from "@playwright/test";

/**
 * Locators and drivers for /admin/users and /change-password, shared by
 * e2e/user-lifecycle.spec.ts and e2e/last-active-admin.spec.ts.
 *
 * WHY THESE ARE CENTRALISED. Group B's accessibility work renamed every row
 * control (each accessible name now carries the account it acts on), turned the
 * Name cell into a `<th scope="row">`, and replaced `disabled` with
 * `aria-disabled`. Two specs holding their own copies of those strings is how a
 * suite ends up half-updated and half-silently-broken. One definition means a
 * future rewording is one edit, and a missed one is a compile-visible import
 * rather than a locator timeout.
 *
 * This file declares no `test()` and is not a `.spec.ts`, so Playwright's
 * testMatch never executes it.
 */

/**
 * Accessible names of the four row controls, exactly as
 * src/components/admin/user-row-actions.tsx renders them.
 *
 * The buttons INSIDE the confirmation dialogs kept their short names
 * ("Deactivate", "Reset password"), which is why `confirmInAlertDialog` takes a
 * plain label while these take an address.
 */
export const control = {
  changeRole: (email: string) => `Change role for ${email}`,
  resetPassword: (email: string) => `Reset password for ${email}`,
  deactivate: (email: string) => `Deactivate ${email}`,
  reactivate: (email: string) => `Reactivate ${email}`,
};

export function userRow(page: Page, email: string) {
  return page.getByTestId(`user-row-${email}`);
}

/** A row control, addressed by the account it acts on. */
export function rowControl(page: Page, email: string, name: string) {
  return userRow(page, email).getByRole("button", { name, exact: true });
}

/** Asserts the current pathname, retrying while a redirect settles. */
export async function expectPathname(page: Page, pathname: string): Promise<void> {
  await expect
    .poll(() => new URL(page.url()).pathname, {
      message: `expected to be on ${pathname}`,
    })
    .toBe(pathname);
}

/** Picks a value in a Radix Select by its trigger id. */
export async function selectRole(page: Page, triggerId: string, label: string): Promise<void> {
  await page.locator(`#${triggerId}`).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

/**
 * Confirms a destructive row action through the alert dialog.
 *
 * 07-05 deliberately uses the styled ui/alert-dialog wrapper rather than
 * window.confirm precisely so this is drivable from a locator. The confirm
 * button is scoped to the open `alertdialog` so it cannot match the row's own
 * trigger.
 */
export async function confirmInAlertDialog(page: Page, buttonName: string): Promise<void> {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: buttonName, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Creates a user through the real /admin/users form and returns the one-time
 * temporary password the panel shows.
 *
 * `emailToType` is passed verbatim so a normalization test can type an address
 * that is not its own stored form. The CALLER records the address for teardown
 * -- each spec owns its own list, keyed on exact addresses, so one run cannot
 * delete another's subjects.
 */
export async function createUserViaUi(
  page: Page,
  name: string,
  emailToType: string,
  roleLabel: string,
): Promise<string> {
  await page.goto("/admin/users");

  await page.locator("#new-user-name").fill(name);
  await page.locator("#new-user-email").fill(emailToType);
  await selectRole(page, "new-user-role", roleLabel);
  await page.getByRole("button", { name: "Create user" }).click();

  // Unscoped is correct HERE and only here: this helper always navigates to a
  // freshly-mounted /admin/users first, and a row's own panel exists only in
  // that row component's state after a reset, so the create form's panel is
  // the only one on the page. Everywhere else the panel and the announcement
  // region must be row-scoped -- there is one announcement per row PLUS one in
  // the create form, and Playwright's strict mode rejects the ambiguity.
  const panel = page.getByTestId("temp-password-panel");
  await expect(panel).toBeVisible();

  const tempPassword = (await panel.getByTestId("temp-password-value").textContent())?.trim();
  expect(tempPassword, "the create form must surface a temporary password").toBeTruthy();

  return tempPassword as string;
}

/**
 * Sets a new password through the real /change-password form.
 *
 * The current password is a REQUIRED field as of this review cycle: an attacker
 * riding a stolen session holds the cookie but not the credential, and without
 * this check could convert the session into a password of their own.
 */
export async function setNewPassword(
  page: Page,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await page.locator("#current-password").fill(currentPassword);
  await page.locator("#new-password").fill(newPassword);
  await page.locator("#confirm-password").fill(newPassword);
  await page.getByRole("button", { name: "Set new password" }).click();
}

/** The user id behind a row, read off the row's own Radix Select trigger id. */
export async function rowUserId(page: Page, email: string): Promise<string> {
  const id = await userRow(page, email).locator('[id^="role-"]').getAttribute("id");
  expect(id, `could not read a user id from the row for ${email}`).toBeTruthy();
  return id!.replace("role-", "");
}
