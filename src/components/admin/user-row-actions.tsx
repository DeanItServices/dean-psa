"use client";

import * as React from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  deactivateUser,
  reactivateUser,
  resetUserPassword,
  updateUserRole,
} from "@/lib/actions/users";
import { ROLE_VALUES } from "@/lib/validations/user";
import { isNextRedirectError } from "@/lib/is-next-redirect-error";

/** The Role literal union, derived from ROLE_VALUES rather than imported
 * from @prisma/client, so no part of the Prisma client is pulled into this
 * client bundle -- the same reasoning that made ROLE_VALUES a string tuple in
 * src/lib/validations/user.ts. Drift between the tuple and the Prisma enum
 * fails tsc where the page passes `user.role` in. */
type RoleValue = (typeof ROLE_VALUES)[number];

function roleLabel(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Per-row lifecycle controls: change role, reset password, deactivate,
 * reactivate. Follows push-to-qbo-button.tsx's action-button convention
 * (useTransition + inline error display, calling the Server Action directly),
 * with company-form.tsx's isNextRedirectError rethrow so a requireRole()
 * redirect still propagates.
 *
 * THIS COMPONENT CONTAINS NO AUTHORIZATION LOGIC AND NO DATABASE WRITE.
 * `isSelf` disables the three controls that 07-03 refuses on a self-target,
 * which is UX only -- the server refusal is the guarantee, and if one of those
 * refusals does come back it is rendered verbatim rather than swallowed. Every
 * { error } return, including the last-active-admin guard rail, lands in the
 * alert below.
 *
 * Destructive confirmation uses the styled ui/alert-dialog wrapper, never the
 * browser's built-in confirm() dialog: that one is unstyled, unthemed, and
 * cannot be driven from a Playwright locator the way a real DOM node can.
 *
 * The temporary password from resetUserPassword lives in `issued` -- ordinary
 * component state, never browser storage of either kind (local or session),
 * never a cookie, never a URL parameter. It cannot survive a navigation or a
 * reload, which is deliberate: only its bcrypt hash reached the database, so
 * once this state is gone the value is unrecoverable and the only remedy is
 * another reset.
 */
export function UserRowActions({
  userId,
  userEmail,
  role,
  isActive,
  isSelf,
}: {
  userId: string;
  userEmail: string;
  role: RoleValue;
  isActive: boolean;
  isSelf: boolean;
}) {
  const [selectedRole, setSelectedRole] = React.useState<string>(role);
  const [error, setError] = React.useState<string | null>(null);
  const [issued, setIssued] = React.useState<string | null>(null);
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle");
  const [isPending, startTransition] = React.useTransition();

  // No effect syncs `selectedRole` back to the `role` prop, deliberately.
  // After a successful change the action's revalidatePath re-renders this row
  // with the role the admin just picked, so the two already agree; after a
  // refused one the handler below reverts explicitly. A useEffect here would
  // be a setState-in-effect cascade (react-hooks/set-state-in-effect) buying
  // nothing but a stale-select cosmetic in the one case where a DIFFERENT
  // admin re-roles this user while a selection sits unsubmitted -- and the
  // next submit is validated server-side against the real row regardless.

  function handleRoleChange() {
    setError(null);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("role", selectedRole);
        const result = await updateUserRole(userId, formData);
        // Truthiness on `result.error`, matching push-to-qbo-button.tsx.
        // `"error" in result` does NOT work: TypeScript normalizes these
        // actions' multi-return unions so every member declares `error`, as
        // `string` or as optional `undefined`. Nothing but the message is
        // needed from a role change, so the union itself is left unnarrowed.
        if (result.error) {
          setError(result.error);
          setSelectedRole(role);
        }
      } catch (err) {
        if (isNextRedirectError(err)) {
          throw err;
        }
        setError("Something went wrong. Please try again.");
        setSelectedRole(role);
      }
    });
  }

  function handleResetPassword() {
    setError(null);
    setIssued(null);
    setCopyState("idle");
    startTransition(async () => {
      try {
        const result = await resetUserPassword(userId);
        // Narrowed on `success` (a `true | undefined` discriminant) rather
        // than on `error`, because only that gives `tempPassword` its
        // non-optional `string` type -- see user-create-form.tsx.
        if (!result.success) {
          setError(result.error);
          return;
        }
        setIssued(result.tempPassword);
      } catch (err) {
        if (isNextRedirectError(err)) {
          throw err;
        }
        setError("Something went wrong. Please try again.");
      }
    });
  }

  function handleDeactivate() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await deactivateUser(userId);
        if (result.error) {
          setError(result.error);
        }
      } catch (err) {
        if (isNextRedirectError(err)) {
          throw err;
        }
        setError("Something went wrong. Please try again.");
      }
    });
  }

  function handleReactivate() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await reactivateUser(userId);
        if (result.error) {
          setError(result.error);
        }
      } catch (err) {
        if (isNextRedirectError(err)) {
          throw err;
        }
        setError("Something went wrong. Please try again.");
      }
    });
  }

  async function handleCopy(value: string) {
    // navigator.clipboard is undefined outside a secure context, and this app
    // runs over plaintext HTTP until Phase 8 delivers TLS. Say so rather than
    // looking like a dead button; the value is selectable text either way.
    try {
      if (!navigator.clipboard) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  const roleSelectId = `role-${userId}`;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Label htmlFor={roleSelectId} className="sr-only">
          Role for {userEmail}
        </Label>
        <Select
          value={selectedRole}
          onValueChange={setSelectedRole}
          disabled={isSelf || isPending}
        >
          <SelectTrigger id={roleSelectId} size="sm" className="w-36">
            <SelectValue placeholder="Select a role" />
          </SelectTrigger>
          <SelectContent>
            {ROLE_VALUES.map((value) => (
              <SelectItem key={value} value={value}>
                {roleLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={handleRoleChange}
          disabled={isSelf || isPending || selectedRole === role}
        >
          Change role
        </Button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" size="sm" variant="outline" disabled={isSelf || isPending}>
              Reset password
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reset the password for {userEmail}?</AlertDialogTitle>
              <AlertDialogDescription>
                Their current password stops working immediately. A new
                temporary password is generated and shown to you exactly once,
                and they must choose a replacement at their next sign-in.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleResetPassword}>
                Reset password
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {isActive ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={isSelf || isPending}
              >
                Deactivate
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Deactivate {userEmail}?</AlertDialogTitle>
                <AlertDialogDescription>
                  They are signed out on their next request and cannot sign in
                  again. Nothing is deleted -- their tickets, comments and time
                  entries stay exactly as they are, and you can reactivate this
                  account from this page at any time.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className={buttonVariants({ variant: "destructive" })}
                  onClick={handleDeactivate}
                >
                  Deactivate
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={handleReactivate}
            disabled={isPending}
          >
            Reactivate
          </Button>
        )}
      </div>

      {isSelf && (
        <p className="text-xs text-muted-foreground">
          This is your own account. You cannot change your own role, reset your
          own password, or deactivate yourself.
        </p>
      )}

      {error && (
        <p className="max-w-md text-left text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {issued && (
        <div
          role="status"
          aria-live="polite"
          data-testid="temp-password-panel"
          className="flex max-w-md flex-col gap-2 rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-left"
        >
          <p className="text-sm font-medium">Temporary password for {userEmail}</p>
          <code
            data-testid="temp-password-value"
            className="select-all rounded bg-background px-2 py-1 font-mono text-sm break-all"
          >
            {issued}
          </code>
          <p className="text-sm text-muted-foreground">
            This will not be shown again. Copy it now and deliver it out of
            band. If it is lost, reset the password again to issue a new one.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => handleCopy(issued)}
            >
              Copy
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setIssued(null);
                setCopyState("idle");
              }}
            >
              Dismiss
            </Button>
            {copyState === "copied" && (
              <span className="text-xs text-muted-foreground">Copied.</span>
            )}
            {copyState === "failed" && (
              <span className="text-xs text-destructive">
                Could not copy automatically. Select the value above and copy
                it manually.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
