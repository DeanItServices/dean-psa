import { redirect, notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { db } from "@/lib/db";
import { InvoiceStatusBadge } from "@/components/invoices/invoice-status-badge";
import { InvoiceLineTable } from "@/components/invoices/invoice-line-table";
import { PushToQboButton } from "@/components/invoices/push-to-qbo-button";
import { Button } from "@/components/ui/button";
import { finalizeInvoice } from "@/lib/actions/invoices";

/**
 * Invoice detail page (/invoices/[invoiceId]). Gated by can(user.role,
 * "invoice:view"), matching the established pattern in
 * src/app/(dashboard)/tickets/[ticketId]/page.tsx. Self-fetches the invoice
 * with lineItems and company. Renders InvoiceStatusBadge, InvoiceLineTable,
 * and (gated invoice:manage, only when status === "draft") a Finalize
 * button.
 *
 * Also renders (Plan 04-06) a PushToQboButton gated invoice:push_qbo, only
 * when status === "finalized"; once status === "pushed", a confirmation
 * line with the qboInvoiceId/qboPushedAt is shown instead.
 *
 * params is a Promise in this Next.js version (App Router dynamic segment
 * convention) -- must be awaited before use, matching the established
 * pattern in src/app/(dashboard)/clients/[companyId]/page.tsx.
 */
export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;

  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  if (!can(user.role, "invoice:view")) {
    redirect("/unauthorized");
  }

  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      lineItems: true,
      company: { select: { id: true, name: true } },
    },
  });

  if (!invoice) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold">{invoice.company.name}</h1>
          <InvoiceStatusBadge status={invoice.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {invoice.periodStart.toLocaleDateString()} – {invoice.periodEnd.toLocaleDateString()}
        </p>
      </div>

      <div className="flex flex-col gap-4 rounded-md border p-4">
        <h2 className="text-lg font-semibold">Line Items</h2>
        <InvoiceLineTable lineItems={invoice.lineItems} />
        <div className="flex flex-col items-end gap-1 text-sm">
          <p>
            Subtotal:{" "}
            {invoice.subtotal.toNumber().toLocaleString("en-US", { style: "currency", currency: "USD" })}
          </p>
          <p className="font-semibold">
            Total: {invoice.total.toNumber().toLocaleString("en-US", { style: "currency", currency: "USD" })}
          </p>
        </div>
      </div>

      {can(user.role, "invoice:manage") && invoice.status === "draft" && (
        <form
          action={async () => {
            "use server";
            await finalizeInvoice(invoice.id);
          }}
        >
          <Button type="submit">Finalize Invoice</Button>
        </form>
      )}

      {can(user.role, "invoice:push_qbo") && invoice.status === "finalized" && (
        <PushToQboButton invoiceId={invoice.id} />
      )}

      {invoice.status === "pushed" && (
        <p className="text-sm text-muted-foreground">
          Pushed to QuickBooks (id: {invoice.qboInvoiceId})
          {invoice.qboPushedAt ? ` on ${invoice.qboPushedAt.toLocaleDateString()}` : null}
        </p>
      )}
    </div>
  );
}
