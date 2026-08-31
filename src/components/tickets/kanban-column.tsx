"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { TicketCard, type KanbanTicket } from "@/components/tickets/ticket-card";

/**
 * One Kanban column for a single TicketStatus value. Wraps its tickets in a
 * SortableContext (drag reordering within/into the column) and marks the
 * column itself as a drop target via useDroppable so an empty column can
 * still receive a dropped card. Empty columns render a visible "No tickets"
 * message rather than collapsing to blank space.
 */
export function KanbanColumn({
  status,
  label,
  tickets,
  draggable,
}: {
  status: string;
  label: string;
  tickets: KanbanTicket[];
  draggable: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div className="flex w-72 shrink-0 flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold">{label}</h2>
        <span className="text-xs text-muted-foreground">{tickets.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-24 flex-1 flex-col gap-2 rounded-md border border-dashed p-2 transition-colors ${
          isOver ? "border-primary bg-accent/50" : "border-border"
        }`}
      >
        <SortableContext items={tickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tickets.length === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-muted-foreground">No tickets</p>
          ) : (
            tickets.map((ticket) => (
              <TicketCard key={ticket.id} ticket={ticket} draggable={draggable} />
            ))
          )}
        </SortableContext>
      </div>
    </div>
  );
}
