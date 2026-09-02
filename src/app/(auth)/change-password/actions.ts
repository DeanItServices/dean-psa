"use server";

import { hash } from "bcryptjs";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export type ChangePasswordResult = { error: string | null };

/**
 * Pinned locally rather than imported from src/lib/validations/user.ts: that
 * module is created by 07-03 in this same wave and may not exist when this
 * file compiles. The value is 12, matching 07-03's MIN_PASSWORD_LENGTH exactly
 * so the two cannot diverge even if the reconciliation is skipped. 07-07
 * replaces this literal with the shared import.
 */
const MIN_PASSWORD_LENGTH = 12;

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
