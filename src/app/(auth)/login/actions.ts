"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";

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
  await signOut({ redirect: false });
}
