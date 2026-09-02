"use server";

import { hash } from "bcryptjs";
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
 * change-password-form.tsx therefore still carries its own literal for the
 * hint text and native minLength -- see 07-07's summary; that file is outside
 * this plan's write targets and the server remains authoritative regardless.
 */

/**
 * Sets a new password for the signed-in user and clears mustChangePassword in
 * a single write, so the (dashboard) gate stops redirecting here on the very
 * next request.
 *
 * The caller is resolved with getCurrentUser(), deliberately NOT the role-gate
 * helper alongside it in src/lib/session.ts: that helper redirects users
 * carrying mustChangePassword to this very page, which is exactly the state
 * every caller here is in, so gating would bounce the page into itself. Only
 * the caller's id is needed, so this works whether or not getCurrentUser() has
 * been switched to a database fresh-check yet.
 *
 * The current or temporary password is deliberately NOT required: the
 * credential was issued out-of-band by an admin, so re-entering it proves
 * nothing the session has not already proven.
 *
 * No password is logged, echoed, or returned.
 */
export async function changePasswordAction(
  newPassword: string,
  confirmPassword: string
): Promise<ChangePasswordResult> {
  const user = await getCurrentUser();

  if (!user?.id) {
    return { error: "Your session has expired. Please sign in again." };
  }

  if (!newPassword) {
    return { error: "Enter a new password." };
  }

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return {
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  if (newPassword !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  // Cost factor 10 matches prisma/seed.ts, so hashes stay comparable across
  // every path that creates a credential.
  const hashedPassword = await hash(newPassword, 10);

  await db.user.update({
    where: { id: user.id },
    data: { hashedPassword, mustChangePassword: false },
  });

  return { error: null };
}
