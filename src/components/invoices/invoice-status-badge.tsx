import { Badge } from "@/components/ui/badge";
import type { InvoiceStatus } from "@prisma/client";

/**
 * Shared invoice status badge, following src/components/tickets/sla-badge.tsx's
 * general shape: a lookup table mapping the enum to a label/variant/class,
 * rendered via a single Badge. Distinct styling per status --
 * draft/finalized/pushed.
 */
const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "Draft",
  finalized: "Finalized",
  pushed: "Pushed to QBO",
};

const STATUS_VARIANT: Record<InvoiceStatus, "outline" | "default" | "secondary" | "destructive"> = {
  draft: "outline",
  finalized: "secondary",
  pushed: "default",
};

const STATUS_CLASS: Record<InvoiceStatus, string> = {
  draft: "text-muted-foreground",
  finalized: "bg-blue-600 text-white [a&]:hover:bg-blue-600/90",
  pushed: "bg-green-600 text-white [a&]:hover:bg-green-600/90",
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className={STATUS_CLASS[status]}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
