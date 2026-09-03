"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export type LoginResult = { error: string | null };

/**
 * Server Action wrapping Auth.js's signIn. Always returns a generic
 * "Invalid email or password" message on failure -- never distinguishes
 * whether the email or the password was wrong, to avoid account enumeration
 * (consistent with src/auth.ts's authorize() returning null uniformly).
 */
export async function loginAction(
  email: string,
  password: string
): Promise<LoginResult> {
  try {
    await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    return { error: null };
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "Invalid email or password" };
    }
    throw error;
  }
}

/**
 * Server Action wrapping Auth.js's signOut, matching the same
 * Server-Action-form pattern used by loginAction above. Used by
 * src/components/nav/user-menu.tsx's "Sign Out" action.
 */
export async function logoutAction(): Promise<void> {
  // Signing out must REVOKE, not merely drop the cookie. signOut() deletes the
  // browser's copy; a JWT captured beforehand stays signature-valid for the
  // full maxAge, so a user who signs out on a shared or public machine has not
  // actually ended the session they think they ended.
  //
  // Incrementing tokenVersion invalidates every token for this account, so this
  // is sign-out-everywhere. That is the right default for an internal tool with
  // no per-device session records; per-device logout would need a device claim.
  //
  // Best-effort: if the user is already unauthenticated or the row is gone,
  // there is nothing to revoke and the cookie drop below still runs.
  const user = await getCurrentUser();
  if (user) {
    await db.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
      select: { id: true },
    });
  }

  await signOut({ redirect: false });
}
