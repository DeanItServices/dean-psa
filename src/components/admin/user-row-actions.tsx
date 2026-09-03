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

/** See the identical note in user-create-form.tsx: the async Clipboard API is
 * undefined outside a secure context and this app is plaintext HTTP until
 * Phase 8, so the Copy button is not rendered at all when it could only fail.
 * Read during render, but only from inside the issued panel, which never
 * exists on the server -- no hydration mismatch. */
function clipboardAvailable() {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function"
  );
}

/**
 * Per-row lifecycle controls: change role, reset password, deactivate,
 * reactivate. Follows push-to-qbo-button.tsx's action-button convention
 * (useTransition + inline error display, calling the Server Action directly),
 * with company-form.tsx's isNextRedirectError rethrow so a requireRole()
 * redirect still propagates.
 *
 * THIS COMPONENT CONTAINS NO AUTHORIZATION LOGIC AND NO DATABASE WRITE.
 * `isSelf` blocks the three controls that 07-03 refuses on a self-target,
 * which is UX only -- the server refusal is the guarantee, and if one of those
 * refusals does come back it is rendered verbatim rather than swallowed. Every
 * { error } return, including the last-active-admin guard rail, lands in the
 * alert below.
 *
 * BLOCKED, NOT `disabled`. Every one of these controls used to carry
 * `disabled={isSelf || isPending}`, which has two costs a keyboard or
 * screen-reader user pays: activating a control disabled the element that had
 * focus, dropping focus to <body> mid-flow, and a `disabled` control is out of
 * the tab order entirely -- so the self-target explanation below was text
 * nobody arriving by keyboard would ever reach. They stay focusable, carry
 * aria-disabled, are described by the reason they are blocked, and every
 * handler returns early. The dialogs are controlled for the same reason: the
 * trigger has to stay pressable-looking without opening.
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

  // Summary text for the always-mounted live region. It deliberately does NOT
  // contain the credential: role="status" implies aria-atomic="true", so the
  // whole region is read out, and a 20-character secret read aloud in a shared
  // office is not an improvement. Focus is moved into the panel instead, where
  // the value is read only if the user goes to it.
  const [announcement, setAnnouncement] = React.useState("");
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Radix restores focus to the trigger when a dialog closes; the panel then
  // takes it when the action resolves. Without this the credential lands below
  // a control the admin is not looking at, unannounced.
  React.useEffect(() => {
    if (issued) {
      panelRef.current?.focus();
    }
  }, [issued]);

  // Open state is controlled so a blocked trigger can stay focusable without
  // opening its dialog. Same for the role menu.
  const [roleMenuOpen, setRoleMenuOpen] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [deactivateOpen, setDeactivateOpen] = React.useState(false);

  // No effect syncs `selectedRole` back to the `role` prop, deliberately.
  // After a successful change the action's revalidatePath re-renders this row
  // with the role the admin just picked, so the two already agree; after a
  // refused one the handler below reverts explicitly. A useEffect here would
  // be a setState-in-effect cascade (react-hooks/set-state-in-effect) buying
  // nothing but a stale-select cosmetic in the one case where a DIFFERENT
  // admin re-roles this user while a selection sits unsubmitted -- and the
  // next submit is validated server-side against the real row regardless.

  const roleSelectId = `role-${userId}`;
  const selfReasonId = `self-reason-${userId}`;
  const errorId = `row-error-${userId}`;
  const panelHeadingId = `temp-password-heading-${userId}`;

  const roleUnchanged = selectedRole === role;
  const roleMenuBlocked = isSelf || isPending;
  const changeRoleBlocked = isSelf || isPending || roleUnchanged;
  const resetBlocked = isSelf || isPending;
  const deactivateBlocked = isSelf || isPending;
  const reactivateBlocked = isPending;

  /** Reasons a control is blocked, in the order they should be read. Both are
   * real elements in this row, so they work as aria-describedby targets. */
  const describedBy =
    [isSelf ? selfReasonId : null, error ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  /** Visual stand-in for :disabled, which no longer applies. Pointer events
   * stay on so a mouse user gets the cursor feedback and a click still lands
   * on a control whose handler refuses it. */
  const blockedClass = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

  function handleRoleChange() {
    if (changeRoleBlocked) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("role", selectedRole);
        const result = await updateUserRole(userId, formData);
        // `"error" in result` FOLLOWED BY a truthiness check, and both halves
        // are load-bearing. Depending on how the action's returns infer,
        // TypeScript either produces a real discriminated union (where the
        // success member has no `error` key at all, so the property access
        // alone is a compile error) or normalizes every member to declare
        // `error?: undefined` (where `in` does not narrow and the truthiness
        // check is what does the work). This form compiles and behaves
        // correctly under both, so a change to the action's return shape
        // cannot silently turn this branch into dead code.
        if ("error" in result && result.error) {
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
    if (resetBlocked) {
      return;
    }
    setError(null);
    setIssued(null);
    setAnnouncement("");
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
        setAnnouncement(
          `Temporary password issued for ${userEmail}. Focus has moved to the panel showing it. It is shown only once.`
        );
      } catch (err) {
        if (isNextRedirectError(err)) {
          throw err;
        }
        setError("Something went wrong. Please try again.");
      }
    });
  }

  function handleDeactivate() {
    if (deactivateBlocked) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const result = await deactivateUser(userId);
        // Same both-shapes-safe narrowing as handleRoleChange above.
        if ("error" in result && result.error) {
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
    if (reactivateBlocked) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const result = await reactivateUser(userId);
        // Same both-shapes-safe narrowing as handleRoleChange above.
        if ("error" in result && result.error) {
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
    // The Copy button is only rendered when clipboardAvailable() says the API
    // exists, so this guard now covers the remaining runtime failures -- a
    // denied permission, an unfocused document. Say so rather than looking
    // like a dead button; the value is selectable text either way.
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

  return (
    // whitespace-normal undoes TableCell's whitespace-nowrap for this cell's
    // contents. Without it every block of prose below -- the self-target
    // explanation, the error, the "will not be shown again" warning -- renders
    // as a single unwrapped line and stretches the table to thousands of
    // pixels inside its overflow-x-auto container. max-w-md constrains the
    // box, not the text, and break-all cannot override white-space: nowrap.
    // Button labels keep their own whitespace-nowrap from buttonVariants.
    <div className="flex flex-col items-end gap-2 whitespace-normal">
      {/*
        Mounted UNCONDITIONALLY and empty until there is something to say: a
        live region must already be in the accessibility tree before its
        content changes, or the change is treated as new content and not
        announced. This is the whole reason the reset flow was silent.
      */}
      <div
        role="status"
        aria-live="polite"
        data-testid="temp-password-announcement"
        className="sr-only"
      >
        {announcement}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Label htmlFor={roleSelectId} className="sr-only">
          Role for {userEmail}
        </Label>
        <Select
          value={selectedRole}
          onValueChange={setSelectedRole}
          open={roleMenuOpen}
          onOpenChange={(next) => {
            if (next && roleMenuBlocked) {
              return;
            }
            setRoleMenuOpen(next);
          }}
        >
          <SelectTrigger
            id={roleSelectId}
            size="sm"
            className={`w-36 ${blockedClass}`}
            aria-disabled={roleMenuBlocked || undefined}
            aria-describedby={describedBy}
          >
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

        {/* Every control below is named with the account it acts on. The row
            itself is announced from the Name cell (a <th scope="row">), but
            only in table-reading mode -- a user tabbing through the page hears
            the button and nothing else, and four rows of "Reset password" are
            indistinguishable. Reactivate especially: it has no confirmation
            dialog to name the target and fires immediately. */}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className={blockedClass}
          onClick={handleRoleChange}
          aria-disabled={changeRoleBlocked || undefined}
          aria-describedby={describedBy}
          aria-label={`Change role for ${userEmail}`}
        >
          Change role
        </Button>

        <AlertDialog
          open={resetOpen}
          onOpenChange={(next) => {
            if (next && resetBlocked) {
              return;
            }
            setResetOpen(next);
          }}
        >
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={blockedClass}
              aria-disabled={resetBlocked || undefined}
              aria-describedby={describedBy}
              aria-label={`Reset password for ${userEmail}`}
            >
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
          <AlertDialog
            open={deactivateOpen}
            onOpenChange={(next) => {
              if (next && deactivateBlocked) {
                return;
              }
              setDeactivateOpen(next);
            }}
          >
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className={blockedClass}
                aria-disabled={deactivateBlocked || undefined}
                aria-describedby={describedBy}
                aria-label={`Deactivate ${userEmail}`}
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
            className={blockedClass}
            onClick={handleReactivate}
            aria-disabled={reactivateBlocked || undefined}
            aria-describedby={describedBy}
            aria-label={`Reactivate ${userEmail}`}
          >
            Reactivate
          </Button>
        )}
      </div>

      {isSelf && (
        <p id={selfReasonId} className="max-w-md text-left text-xs text-muted-foreground">
          This is your own account. You cannot change your own role, reset your
          own password, or deactivate yourself.
        </p>
      )}

      {error && (
        <p id={errorId} className="max-w-md text-left text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {issued && (
        // A labelled group that focus moves into -- not a live region. See
        // the note on `announcement` above.
        <div
          ref={panelRef}
          tabIndex={-1}
          role="group"
          aria-labelledby={panelHeadingId}
          data-testid="temp-password-panel"
          className="flex max-w-md flex-col gap-2 rounded-md border border-warning-border bg-warning p-3 text-left text-warning-foreground outline-none focus:outline-2 focus:outline-offset-2 focus:outline-ring"
        >
          <p id={panelHeadingId} className="text-sm font-medium">
            Temporary password for {userEmail}
          </p>
          <code
            data-testid="temp-password-value"
            className="select-all rounded bg-background px-2 py-1 font-mono text-sm break-all"
          >
            {issued}
          </code>
          <p className="text-sm">
            This will not be shown again. Copy it now and deliver it out of
            band. If it is lost, reset the password again to issue a new one.
          </p>
          {!clipboardAvailable() && (
            <p className="text-sm">
              Copying automatically is unavailable on this connection. Select
              the value above and copy it manually.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {clipboardAvailable() && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => handleCopy(issued)}
                aria-label={`Copy the temporary password for ${userEmail}`}
              >
                Copy
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setIssued(null);
                setCopyState("idle");
                setAnnouncement("");
              }}
              aria-label={`Dismiss the temporary password for ${userEmail}`}
            >
              Dismiss
            </Button>
            {copyState === "copied" && <span className="text-xs">Copied.</span>}
            {copyState === "failed" && (
              <span className="text-xs font-medium">
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
