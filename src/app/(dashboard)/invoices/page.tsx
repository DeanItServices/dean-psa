import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { db } from "@/lib/db";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InvoiceStatusBadge } from "@/components/invoices/invoice-status-badge";
import { GenerateInvoiceForm } from "@/components/invoices/generate-invoice-form";

/**
 * Invoice list (/invoices). View-gated by can(role, "invoice:view") directly
 * (NOT requireRole, matching the established pattern in
 * src/app/(dashboard)/tickets/page.tsx) -- redirects to /unauthorized
 * otherwise. Self-fetches all invoices ordered createdAt desc with company
 * name. The GenerateInvoiceForm (company select + 2 date inputs) is only
 * rendered for invoice:manage.
 */
export default async function InvoicesPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  if (!can(user.role, "invoice:view")) {
    redirect("/unauthorized");
  }

  const invoices = await db.invoice.findMany({
    orderBy: { createdAt: "desc" },
    include: { company: { select: { id: true, name: true } } },
  });

  const canManage = can(user.role, "invoice:manage");

  const companies = canManage
    ? await db.company.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } })
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Invoices</h1>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Company</TableHead>
            <TableHead>Period</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                No invoices yet.
              </TableCell>
            </TableRow>
          ) : (
            invoices.map((invoice) => (
              <TableRow key={invoice.id}>
                <TableCell>
                  <Link href={`/invoices/${invoice.id}`} className="font-medium hover:underline">
                    {invoice.company.name}
                  </Link>
                </TableCell>
                <TableCell>
                  {invoice.periodStart.toLocaleDateString()} – {invoice.periodEnd.toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <InvoiceStatusBadge status={invoice.status} />
                </TableCell>
                <TableCell className="text-right">
                  {invoice.total.toNumber().toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                  })}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {canManage && <GenerateInvoiceForm companies={companies} />}
    </div>
  );
}
