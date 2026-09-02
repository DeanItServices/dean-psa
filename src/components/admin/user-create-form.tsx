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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    // navigator.clipboard is undefined outside a secure context, and this app
    // is served over plaintext HTTP until Phase 8 delivers TLS. Failing
    // silently would look like a broken button, so say so and point at the
    // manual path -- the value is rendered as selectable text regardless.
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
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-md">
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

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating..." : "Create user"}
        </Button>
      </form>

      {issued && (
        <div
          role="status"
          aria-live="polite"
          data-testid="temp-password-panel"
          className="flex max-w-md flex-col gap-2 rounded-md border border-amber-600/40 bg-amber-500/10 p-3"
        >
          <p className="text-sm font-medium">
            Temporary password for {issued.email}
          </p>
          <code
            data-testid="temp-password-value"
            className="select-all rounded bg-background px-2 py-1 font-mono text-sm break-all"
          >
            {issued.tempPassword}
          </code>
          <p className="text-sm text-muted-foreground">
            This will not be shown again. Copy it now and deliver it to the
            user out of band. They will be required to choose a new password at
            first sign-in. If it is lost, use Reset password on their row to
            issue a new one.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => handleCopy(issued.tempPassword)}
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
