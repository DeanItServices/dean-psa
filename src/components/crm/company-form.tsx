"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCompany } from "@/lib/actions/companies";

/**
 * Create-company form. Calls createCompany (a Server Action) directly on
 * submit, following the same client-state + direct-Server-Action-call
 * pattern used by src/app/(auth)/login/page.tsx. On success, createCompany
 * redirects server-side to the new company's detail page -- this component
 * never navigates itself.
 */
export function CompanyForm() {
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.set("name", name);
      const result = await createCompany(formData);
      if (result?.error) {
        setError(result.error);
      }
    } catch (err) {
      // Server Actions that call redirect() throw a special Next.js
      // redirect error internally that must be allowed to propagate.
      if (
        err &&
        typeof err === "object" &&
        "digest" in err &&
        typeof (err as { digest?: unknown }).digest === "string" &&
        (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
      ) {
        throw err;
      }
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-md">
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Company name</Label>
        <Input
          id="name"
          name="name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Creating..." : "Create company"}
      </Button>
    </form>
  );
}
