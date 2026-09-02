"use client";

// Split out of page.tsx because "use client" is file-scoped: the page must
// resolve the session on the server, and this form must hold submit state and
// surface the action's { error } inline the way the login page does.
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePasswordAction } from "./actions";

/**
 * Mirrors the server-side minimum in ./actions.ts. This copy drives only the
 * hint text and the native minLength attribute -- the server remains
 * authoritative. Both are pinned at 12 to match 07-03's MIN_PASSWORD_LENGTH;
 * 07-07 replaces both literals with the shared import.
 */
const MIN_PASSWORD_LENGTH = 12;

export function ChangePasswordForm() {
  const router = useRouter();
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const result = await changePasswordAction(newPassword, confirmPassword);
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

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          aria-describedby="new-password-hint"
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
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? "Saving..." : "Set new password"}
      </Button>
    </form>
  );
}
