"use client";

// Split out of page.tsx because "use client" is file-scoped: the page must
// resolve the session on the server, and this form must hold submit state and
// surface the action's { error } inline the way the login page does.
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH } from "@/lib/validations/user";
import { changePasswordAction } from "./actions";

// MIN_PASSWORD_LENGTH is imported, not restated. It drives only the hint text
// and the native minLength attribute here -- the server remains authoritative.
// The import is safe from a client component: @/lib/validations/user pulls in
// only zod, and user-create-form.tsx and user-row-actions.tsx already import
// ROLE_VALUES from it.

export function ChangePasswordForm() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      // The third argument is an OBJECT, not a third positional string: three
      // bare strings would be silently transposable and would type-check
      // either way. The action treats a missing currentPassword as a refusal
      // (it is typed optional only so the server fix could land before this
      // form did), so omitting it here is a silent no-op, not a type error.
      const result = await changePasswordAction(newPassword, confirmPassword, {
        currentPassword,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      // The flag is cleared, so the dashboard gate no longer bounces us back.
      router.push("/");
      router.refresh();
    } catch {
      setError("Could not change your password. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  // Every error this action returns is about the pair -- too short, or the two
  // fields disagree -- so both inputs are marked invalid and both point at the
  // message. `aria-describedby` is a space-separated ID list: the hint stays,
  // the error is appended in front of it so it is read first.
  const errorId = "change-password-error";

  // method="post" below is load-bearing, for the same reason as /login: a form
  // with only an onSubmit handler falls back to the HTML default when submitted
  // before React hydrates -- a GET carrying every named field in the query
  // string. Here that would be the current AND the new password, landing in the
  // URL bar, browser history and every access log.
  return (
    <form method="post" onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="current-password">Current password</Label>
        <Input
          id="current-password"
          name="current-password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={
            error ? `${errorId} current-password-hint` : "current-password-hint"
          }
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <p id="current-password-hint" className="text-sm text-muted-foreground">
          The password you just signed in with. If an admin issued you a
          temporary one, enter that.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            error ? `${errorId} new-password-hint` : "new-password-hint"
          }
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <p id="new-password-hint" className="text-sm text-muted-foreground">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input
          id="confirm-password"
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
      </div>
      {error && (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? "Saving..." : "Set new password"}
      </Button>
    </form>
  );
}
