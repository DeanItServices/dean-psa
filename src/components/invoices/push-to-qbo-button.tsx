"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { pushInvoiceToQbo } from "@/lib/actions/invoices";

/**
 * "Push to QuickBooks" button for the invoice detail page. Follows
 * ticket-form.tsx's pending-state pattern (useTransition + inline error
 * display), but calls a plain async Server Action directly rather than
 * building FormData, since pushInvoiceToQbo takes a single invoiceId
 * argument and has no form fields.
 *
 * Rendering/gating (status === "finalized" && invoice:push_qbo) is the
 * invoice detail page's responsibility, not this component's -- this
 * component assumes it should only ever be mounted when the push action is
 * valid to attempt, and pushInvoiceToQbo itself re-validates all of that
 * server-side regardless.
 */
export function PushToQboButton({ invoiceId }: { invoiceId: string }) {
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await pushInvoiceToQbo(invoiceId);
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" onClick={handleClick} disabled={isPending}>
        {isPending ? "Pushing..." : "Push to QuickBooks"}
      </Button>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
