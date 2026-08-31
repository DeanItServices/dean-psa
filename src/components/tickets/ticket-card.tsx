"use client";

import Link from "next/link";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SlaBadge } from "@/components/tickets/sla-badge";

export type KanbanTicket = {
  id: string;
  subject: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: string;
  slaResponseDeadline: Date | null;
  slaResolutionDeadline: Date | null;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
  assignedTo: { id: string; name: string | null; email: string } | null;
  company: { id: string; name: string };
};

const PRIORITY_VARIANT: Record<KanbanTicket["priority"], "outline" | "default" | "secondary" | "destructive"> = {
  low: "outline",
  normal: "secondary",
  high: "default",
  urgent: "destructive",
};

function initials(name: string | null, email: string) {
  const source = name?.trim() || email;
  return source.slice(0, 2).toUpperCase();
}

/**
 * A single Kanban card. When `draggable` is true, wires up @dnd-kit's
 * useSortable so the card can be picked up via pointer OR keyboard (Space to
 * lift, arrow keys to move, Space to drop -- @dnd-kit's default keyboard
 * sensor, not disabled here). When `draggable` is false (viewer lacks
 * ticket:manage), the card renders as a plain link-only card with no drag
 * handle, matching the read-only requirement for sales/finance roles.
 */
export function TicketCard({ ticket, draggable }: { ticket: KanbanTicket; draggable: boolean }) {
  const sortable = useSortable({ id: ticket.id, disabled: !draggable });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={`gap-2 py-3 ${isDragging ? "opacity-50" : ""}`}
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
    >
      <CardContent className="flex flex-col gap-2 px-3">
        <Link
          href={`/tickets/${ticket.id}`}
          className="text-sm font-medium leading-snug hover:underline"
          onClick={(event) => {
            // Prevent a drag gesture's pointerdown from swallowing the click
            // navigation on a plain tap.
            if (isDragging) event.preventDefault();
          }}
        >
          {ticket.subject}
        </Link>
        <p className="text-xs text-muted-foreground">{ticket.company.name}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={PRIORITY_VARIANT[ticket.priority]}>{ticket.priority}</Badge>
          <SlaBadge ticket={ticket} />
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Avatar size="sm">
            <AvatarFallback>
              {ticket.assignedTo ? initials(ticket.assignedTo.name, ticket.assignedTo.email) : "?"}
            </AvatarFallback>
          </Avatar>
          <span className="text-xs text-muted-foreground">
            {ticket.assignedTo ? ticket.assignedTo.name ?? ticket.assignedTo.email : "Unassigned"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
