"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { addComment } from "@/lib/actions/ticket-comments";
import { isNextRedirectError } from "@/lib/is-next-redirect-error";

/**
 * Comment/internal-note form on the ticket detail page. Follows the same
 * per-field useState + manual FormData pattern as the CRM forms. Gated to
 * ticket:manage users by the caller (the detail page only renders this
 * component when the current user has that permission) -- this component
 * itself does not re-check the role client-side, since addComment is
 * authoritatively RBAC-gated server-side regardless.
 */
export function TicketCommentForm({ ticketId }: { ticketId: string }) {
  const [body, setBody] = React.useState("");
  const [isInternal, setIsInternal] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.set("body", body);
      formData.set("isInternal", isInternal ? "on" : "off");

      const result = await addComment(ticketId, formData);
      if (result?.error) {
        setError(result.error);
        return;
      }

      setBody("");
      setIsInternal(false);
    } catch (err) {
      if (isNextRedirectError(err)) {
        throw err;
      }
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor="body">Add a comment</Label>
        <Textarea
          id="body"
          name="body"
          required
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={isInternal}
          onChange={(event) => setIsInternal(event.target.checked)}
        />
        Internal note (not customer-visible)
      </label>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={isSubmitting} className="self-start">
        {isSubmitting ? "Posting..." : "Post comment"}
      </Button>
    </form>
  );
}
