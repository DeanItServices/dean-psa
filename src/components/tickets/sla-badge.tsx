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

// This project's theme (src/app/globals.css) defines only the shadcn/ui
// default token set (primary/secondary/accent/muted/destructive) -- no
// custom success/warning semantic tokens exist. Rather than inventing new
// tokens, on_track/met and approaching are distinguished using the closest
// existing theme-token-based classes already used elsewhere for badges
// (see src/components/ui/badge.tsx's variant styles): `primary` for the
// positive/on-track states and `secondary` for the cautionary "approaching"
// state. Both adapt automatically in dark mode since --primary/--secondary
// (and their -foreground pairs) are redefined under .dark in globals.css.
// `breached` intentionally stays empty -- see STATUS_VARIANT below.
const STATUS_CLASS: Record<SlaStatus, string> = {
  no_sla: "text-muted-foreground",
  on_track: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
  approaching: "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
  breached: "",
  met: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
};

export function SlaBadge({ ticket }: { ticket: TicketForSla }) {
  const status = getSlaStatus(ticket);

  return (
    <Badge variant={STATUS_VARIANT[status]} className={STATUS_CLASS[status]}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
