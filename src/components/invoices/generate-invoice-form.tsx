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
import { generateInvoice } from "@/lib/actions/invoices";
import { isNextRedirectError } from "@/lib/is-next-redirect-error";

type CompanyOption = { id: string; name: string };

/**
 * Generate-invoice form. Follows src/components/tickets/ticket-form.tsx's
 * exact pending-state/error-display pattern: per-field useState, a
 * manually-built FormData passed directly to the Server Action, and
 * isNextRedirectError in the catch block (generateInvoice redirects
 * server-side on success).
 */
export function GenerateInvoiceForm({ companies }: { companies: CompanyOption[] }) {
  const [companyId, setCompanyId] = React.useState("");
  const [periodStart, setPeriodStart] = React.useState("");
  const [periodEnd, setPeriodEnd] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.set("companyId", companyId);
      formData.set("periodStart", periodStart);
      formData.set("periodEnd", periodEnd);

      const result = await generateInvoice(formData);

      if (result?.error) {
        setError(result.error);
      }
    } catch (err) {
      // generateInvoice calls redirect() internally on success, which
      // throws a special Next.js redirect error that must be allowed to
      // propagate.
      if (isNextRedirectError(err)) {
        throw err;
      }
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-md rounded-md border p-4">
      <h2 className="text-sm font-semibold">Generate Invoice</h2>

      <div className="flex flex-col gap-2">
        <Label htmlFor="companyId">Company</Label>
        <Select value={companyId} onValueChange={setCompanyId}>
          <SelectTrigger id="companyId" className="w-full">
            <SelectValue placeholder="Select a company" />
          </SelectTrigger>
          <SelectContent>
            {companies.map((company) => (
              <SelectItem key={company.id} value={company.id}>
                {company.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="periodStart">Period start</Label>
        <Input
          id="periodStart"
          name="periodStart"
          type="date"
          required
          value={periodStart}
          onChange={(event) => setPeriodStart(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="periodEnd">Period end</Label>
        <Input
          id="periodEnd"
          name="periodEnd"
          type="date"
          required
          value={periodEnd}
          onChange={(event) => setPeriodEnd(event.target.value)}
        />
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={isSubmitting || !companyId || !periodStart || !periodEnd}>
        {isSubmitting ? "Generating..." : "Generate Invoice"}
      </Button>
    </form>
  );
}
