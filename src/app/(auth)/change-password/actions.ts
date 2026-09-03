"use server";

import { z } from "zod";
import { compare, hash } from "bcryptjs";
import { signIn } from "@/auth";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { MIN_PASSWORD_LENGTH } from "@/lib/validations/user";

export type ChangePasswordResult = { error: string | null };

/*
 * The password minimum is IMPORTED, not restated. 07-04 pinned a local `12`
 * here only because src/lib/validations/user.ts was being created by 07-03 in
 * the same wave and could not be imported yet; 07-07 reconciled the two. Both
 * values were 12, so this is a no-op behaviourally and a real change
 * structurally: there is now exactly one definition of "minimum password
 * length" behind every server-side write, and widening the policy cannot leave
 * this route enforcing the old floor.
 *
 * Note this file is "use server": it may IMPORT the constant but must not
 * re-export it, because a "use server" module may only export async functions.
 * change-password-form.tsx therefore imports MIN_PASSWORD_LENGTH directly from
 * @/lib/validations/user rather than through this module. Both sides now read
 * one definition; the server remains authoritative regardless.
 */

/**
 * CALLER CONTRACT for change-password-form.tsx
 * -------------------------------------------
 *   changePasswordAction(newPassword, confirmPassword, { currentPassword })
 *
 * The third argument is an OBJECT, not a third bare string, on purpose. Three
 * positional strings would be silently reorderable -- passing the current
 * password where the new one is expected type-checks perfectly and fails in a
 * confusing way at runtime. A named field cannot be transposed.
 *
 * It is typed optional ONLY so this security fix could land without editing
 * change-password-form.tsx, which another agent owns in this review cycle. It
 * is REQUIRED at runtime: omitting it returns "Enter your current password."
 * and changes nothing. Once the form passes it, this parameter should be made
 * required and the optionality removed.
 */

/**
 * Sets a new password for the signed-in user and clears mustChangePassword in
 * a single write, so the (dashboard) gate stops redirecting here on the very
 * next request.
 *
 * The caller is resolved with getCurrentUser(), deliberately NOT the role-gate
 * helper alongside it in src/lib/session.ts: that helper redirects users
 * carrying mustChangePassword to this very page, which is exactly the state
 * every caller here is in, so gating would bounce the page into itself.
 *
 * THE CURRENT PASSWORD IS REQUIRED, and this reverses an earlier decision that
 * said re-entering it "proves nothing the session has not already proven".
 * That reasoning had a hole: it is exactly what an attacker riding a stolen
 * session needs. Such an attacker holds the session but NOT the credential, so
 * without this check they can convert a stolen cookie into a password of their
 * own choosing -- a permanent takeover, and one that also survives the admin's
 * password reset. The legitimate user of this page always has the credential:
 * either the temporary password an admin just handed them, or their current
 * one. Requiring it costs them one field and costs the attacker everything.
 *
 * The comparison is a bcrypt compare against the stored hash, fetched here
 * rather than taken from getCurrentUser(), whose `select` deliberately never
 * loads hashedPassword.
 *
 * On success `tokenVersion` is incremented in the same write, which revokes
 * every JWT issued before this moment (see src/lib/session.ts). A fresh token
 * is then minted for the caller from the password they just chose, so this
 * device stays signed in while every other session -- including an attacker's
 * -- is terminated.
 *
 * No password is logged, echoed, or returned.
 */
export async function changePasswordAction(
  newPassword: string,
  confirmPassword: string,
  options?: { currentPassword: string },
): Promise<ChangePasswordResult> {
  const user = await getCurrentUser();

  if (!user?.id) {
    return { error: "Your session has expired. Please sign in again." };
  }

  // Parsed, not hand-checked. A Server Action accepts arbitrary JSON off the
  // wire, so these arguments are NOT guaranteed to be strings just because the
  // signature says so. The previous `newPassword.length < MIN_PASSWORD_LENGTH`
  // was skippable by sending a JSON number: `undefined < 12` is false, so the
  // floor did not apply and execution reached bcrypt, which threw an unhandled
  // 500. Fail-closed, but the check was bypassable at its own line.
  // The message is set on BOTH the type error and the length error. zod's
  // `.min(n, msg)` only fires when the value already IS a string; an absent or
  // non-string value raises invalid_type instead and would surface zod's own
  // "expected string, received undefined" to the user. These are user-facing
  // strings on the login-adjacent path, so they must not leak parser internals.
  const missingCurrent = "Enter your current password.";
  const tooShort = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;

  const parsed = z
    .object({
      currentPassword: z
        .string({ error: missingCurrent })
        .min(1, missingCurrent),
      newPassword: z.string({ error: tooShort }).min(MIN_PASSWORD_LENGTH, tooShort),
      confirmPassword: z.string({ error: "Passwords do not match." }),
    })
    .safeParse({
      currentPassword: options?.currentPassword,
      newPassword,
      confirmPassword,
    });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { currentPassword } = parsed.data;

  if (parsed.data.newPassword !== parsed.data.confirmPassword) {
    return { error: "Passwords do not match." };
  }

  const credential = await db.user.findUnique({
    where: { id: user.id },
    select: { email: true, hashedPassword: true },
  });

  // A row that vanished between the two reads, or an account with no password
  // set at all (the column is nullable), cannot prove possession of a current
  // password and must not be allowed to set a new one.
  if (!credential?.hashedPassword) {
    return { error: "Your session has expired. Please sign in again." };
  }

  if (!(await compare(currentPassword, credential.hashedPassword))) {
    // Deliberately the same shape as every other returned error: no timing
    // claim is made here, but nothing in the message distinguishes "wrong
    // current password" from anything an attacker could use to probe further.
    return { error: "Current password is incorrect." };
  }

  // Refuse a no-op. Re-setting the same value would clear mustChangePassword
  // while leaving the admin-issued temporary credential in place -- the exact
  // outcome this page exists to prevent.
  if (await compare(newPassword, credential.hashedPassword)) {
    return { error: "Choose a password different from your current one." };
  }

  // Cost factor 10 matches prisma/seed.ts, so hashes stay comparable across
  // every path that creates a credential.
  const hashedPassword = await hash(newPassword, 10);

  await db.user.update({
    where: { id: user.id },
    data: {
      hashedPassword,
      mustChangePassword: false,
      // Revokes every session minted before this write, this one included.
      tokenVersion: { increment: 1 },
    },
  });

  // The line above just invalidated the caller's own JWT. Mint a replacement
  // from the password they chose one second ago, so the intended flow (set a
  // password, land on the dashboard) still works while every OTHER session for
  // this account stays revoked.
  //
  // Failure here is not a failure of the password change, which has already
  // committed. Swallow it: the caller simply finds themselves signed out and
  // signs back in with the password they just set. Reporting an error would be
  // actively wrong -- it would tell them the change did not happen when it did.
  try {
    await signIn("credentials", {
      email: credential.email,
      password: newPassword,
      redirect: false,
    });
  } catch {
    // Intentionally ignored -- see above.
  }

  return { error: null };
}
