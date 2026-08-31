import { Badge } from "@/components/ui/badge";
import { getSlaStatus, type SlaStatus } from "@/lib/sla";

/**
 * Shared SLA status badge. The SOLE rendering implementation of SLA status
 * across the tickets UI (Kanban card + detail page both import this) --
 * per 03-CONTEXT.md's "single-shared-implementation rationale", do not
 * duplicate getSlaStatus's derivation logic anywhere else. Server-renderable
 * (no client-only state needed) -- callers may use it from an async Server
 * Component directly.
 */
type TicketForSla = {
  status: string;
  slaResponseDeadline: Date | null;
  slaResolutionDeadline: Date | null;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
};

const STATUS_LABEL: Record<SlaStatus, string> = {
  no_sla: "No SLA",
  on_track: "On track",
  approaching: "Approaching",
  breached: "Breached",
  met: "Met",
};

const STATUS_VARIANT: Record<SlaStatus, "outline" | "default" | "secondary" | "destructive"> = {
  no_sla: "outline",
  on_track: "default",
  approaching: "secondary",
  breached: "destructive",
  met: "default",
};

const STATUS_CLASS: Record<SlaStatus, string> = {
  no_sla: "text-muted-foreground",
  on_track: "bg-green-600 text-white [a&]:hover:bg-green-600/90",
  approaching: "bg-yellow-500 text-black [a&]:hover:bg-yellow-500/90",
  breached: "",
  met: "bg-green-600 text-white [a&]:hover:bg-green-600/90",
};

export function SlaBadge({ ticket }: { ticket: TicketForSla }) {
  const status = getSlaStatus(ticket);

  return (
    <Badge variant={STATUS_VARIANT[status]} className={STATUS_CLASS[status]}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
