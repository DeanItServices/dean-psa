import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Prisma } from "@prisma/client";

type InvoiceLineItemRow = Pick<
  Prisma.InvoiceLineItemGetPayload<Record<string, never>>,
  "id" | "description" | "quantity" | "unitRate" | "amount"
>;

function formatCurrency(value: Prisma.Decimal | number): string {
  const num = typeof value === "number" ? value : value.toNumber();
  return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatQuantity(value: Prisma.Decimal | number): string {
  const num = typeof value === "number" ? value : value.toNumber();
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * Renders an Invoice's line items as a table. Column set matches the
 * InvoiceLineItem model's billable fields exactly: description, quantity,
 * unitRate, amount. Empty-state colSpan is set to the actual column count
 * (4) so it never renders a raggedly-short empty row.
 */
export function InvoiceLineTable({ lineItems }: { lineItems: InvoiceLineItemRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Description</TableHead>
          <TableHead className="text-right">Quantity</TableHead>
          <TableHead className="text-right">Unit Rate</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lineItems.length === 0 ? (
          <TableRow>
            <TableCell colSpan={4} className="text-center text-muted-foreground">
              No line items on this invoice.
            </TableCell>
          </TableRow>
        ) : (
          lineItems.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="whitespace-normal">{item.description}</TableCell>
              <TableCell className="text-right">{formatQuantity(item.quantity)}</TableCell>
              <TableCell className="text-right">{formatCurrency(item.unitRate)}</TableCell>
              <TableCell className="text-right">{formatCurrency(item.amount)}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
