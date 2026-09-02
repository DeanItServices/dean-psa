"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createUser } from "@/lib/actions/users";
import { ROLE_VALUES } from "@/lib/validations/user";
import { isNextRedirectError } from "@/lib/is-next-redirect-error";

/** Human label for a Role literal. ROLE_VALUES is the single source of the
 * option list (imported from the validation module rather than the Prisma
 * enum, which must not reach a client bundle -- see 07-03's decision). */
function roleLabel(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** Whether the async Clipboard API is actually usable here. It is undefined
 * outside a secure context and this app is plaintext HTTP until Phase 8, so
 * offering a Copy button that can only ever fail makes an admin's first
 * interaction with a one-time credential a failure. Called during render, but
 * only from inside the issued panel, which cannot exist on the server (the
 * state driving it starts null) -- so there is no hydration mismatch. */
function clipboardAvailable() {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function"
  );
}

/**
 * Create-user form. Follows company-form.tsx exactly: per-field useState, a
 * manually-built FormData handed straight to the Server Action, and
 * isNextRedirectError in the catch so requireRole()'s redirect propagates.
 *
 * There is deliberately NO password field. createUser generates the temporary
 * password server-side and returns it once; an admin never chooses another
 * person's password.
 *
 * THE ONE-TIME PASSWORD IS COMPONENT STATE AND NOTHING ELSE. It is held in
 * `issued` below -- not browser storage of either kind (local or session), not
 * a cookie, not a query parameter, not a router push. React state does not
 * survive a navigation or a reload, so once this component unmounts it is gone
 * from the browser as completely as it is from the server, where only its
 * bcrypt hash was ever stored. That is the point: there is no "show it to me
 * again". If it is lost, the remedy is Reset password on the user's row,
 * which issues a different one.
 */
export function UserCreateForm() {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<string>("technician");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [issued, setIssued] = React.useState<{
    email: string;
    tempPassword: string;
  } | null>(null);
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle");

  // The text handed to the live region below. Kept SEPARATE from the panel's
  // contents on purpose: role="status" implies aria-atomic="true", so whatever
  // sits inside the region is read out in full -- and reading a 20-character
  // credential aloud in a shared office is not an accessibility win. The
  // announcement is a summary; the value itself is only ever read by the user
  // navigating into the panel focus is moved to.
  const [announcement, setAnnouncement] = React.useState("");
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Move focus to the panel once it exists. Without this the credential is
  // rendered somewhere below a submit button that still holds focus, and the
  // one piece of information in this whole flow that cannot be recovered is
  // the one piece the admin is least likely to be looking at.
  React.useEffect(() => {
    if (issued) {
      panelRef.current?.focus();
    }
  }, [issued]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The submit button is aria-disabled rather than disabled while this runs
    // (see below), so it can still be activated -- this is the re-entrancy
    // guard that `disabled` used to provide.
    if (isSubmitting) {
      return;
    }
    setError(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.set("name", name);
      formData.set("email", email);
      formData.set("role", role);

      const result = await createUser(formData);

      // Narrow on `success`, not on `"error" in result`. TypeScript
      // normalizes a multi-return action's union so EVERY member declares
      // every key -- the failure member carries `success?: undefined` -- which
      // makes `in` useless here. `success` is `true | undefined`: two unit
      // types, so it is a real discriminant and narrowing it gives
      // `tempPassword` its non-optional `string` type below.
      if (!result.success) {
        setError(result.error);
        return;
      }

      // Clear the inputs so the next account starts from a blank form, and
      // surface the temporary password. Deliberately not cleared on a timer:
      // the admin dismisses it when they have handed it over.
      setName("");
      setEmail("");
      setRole("technician");
      setCopyState("idle");
      setIssued({ email: result.email, tempPassword: result.tempPassword });
      setAnnouncement(
        `Temporary password issued for ${result.email}. Focus has moved to the panel showing it. It is shown only once.`
      );
    } catch (err) {
      // Server Actions that call redirect() -- requireRole() does, for a
      // caller who lost the admin role mid-session -- throw a special Next.js
      // error that must be allowed to propagate.
      if (isNextRedirectError(err)) {
        throw err;
      }
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCopy(value: string) {
    // The button this runs from is only rendered when clipboardAvailable()
    // says the API exists, so the guard below now covers the remaining runtime
    // failures -- a denied clipboard-write permission, a document that is not
    // focused. Failing silently would look like a broken button, so say so and
    // point at the manual path; the value is selectable text regardless.
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

  const errorId = "create-user-error";
  const panelHeadingId = "create-user-temp-password-heading";

  return (
    <div className="flex flex-col gap-4">
      {/*
        Mounted UNCONDITIONALLY and empty until there is something to say. A
        live region has to exist in the accessibility tree BEFORE its content
        changes for the change to be treated as a mutation; a region that
        appears in the same commit as its text is, to NVDA/JAWS/VoiceOver,
        just new content -- which is why the previous version of this panel
        announced nothing at all.
      */}
      <div
        role="status"
        aria-live="polite"
        data-testid="temp-password-announcement"
        className="sr-only"
      >
        {announcement}
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 max-w-md"
        aria-describedby={error ? errorId : undefined}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-user-name">Name</Label>
          <Input
            id="new-user-name"
            name="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="new-user-email">Email</Label>
          <Input
            id="new-user-email"
            name="email"
            type="email"
            autoComplete="off"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="new-user-role">Role</Label>
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger id="new-user-role" className="w-full">
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
        </div>

        {/* The action returns one already-formatted message and no field
            path, so this is associated with the FORM rather than guessed onto
            a particular input -- pointing aria-invalid at the wrong control is
            worse than pointing it at none. */}
        {error && (
          <p id={errorId} className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {/* aria-disabled, not disabled: `disabled` takes the element out of
            the tab order the moment it is clicked, so the browser blurs it to
            <body> and the focus move onto the issued panel below has nothing
            to return to if it fails. Also described by the error, since focus
            stays here after a refused submit. */}
        <Button
          type="submit"
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-disabled={isSubmitting || undefined}
          aria-describedby={error ? errorId : undefined}
        >
          {isSubmitting ? "Creating..." : "Create user"}
        </Button>
      </form>

      {issued && (
        // Not a live region itself -- see the note on `announcement`. It is a
        // labelled group that focus is moved into, so the credential is read
        // when the user reaches it rather than broadcast on arrival.
        <div
          ref={panelRef}
          tabIndex={-1}
          role="group"
          aria-labelledby={panelHeadingId}
          data-testid="temp-password-panel"
          className="flex max-w-md flex-col gap-2 rounded-md border border-warning-border bg-warning p-3 text-warning-foreground outline-none focus:outline-2 focus:outline-offset-2 focus:outline-ring"
        >
          <p id={panelHeadingId} className="text-sm font-medium">
            Temporary password for {issued.email}
          </p>
          <code
            data-testid="temp-password-value"
            className="select-all rounded bg-background px-2 py-1 font-mono text-sm break-all"
          >
            {issued.tempPassword}
          </code>
          <p className="text-sm">
            This will not be shown again. Copy it now and deliver it to the
            user out of band. They will be required to choose a new password at
            first sign-in. If it is lost, use Reset password on their row to
            issue a new one.
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
                onClick={() => handleCopy(issued.tempPassword)}
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
            >
              Dismiss
            </Button>
            {copyState === "copied" && (
              <span className="text-xs">Copied.</span>
            )}
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
