"use client";

import * as React from "react";
import type { Role } from "@prisma/client";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { can } from "@/lib/permissions";
import { updateTicketStatus } from "@/lib/actions/tickets";
import { KanbanColumn } from "@/components/tickets/kanban-column";
import { TicketCard, type KanbanTicket } from "@/components/tickets/ticket-card";

/**
 * Fixed Kanban column order, per 03-CONTEXT.md's UI/routing decisions --
 * mirrors the TicketStatus enum's declared order in prisma/schema.prisma.
 */
const STATUS_COLUMNS: { status: KanbanTicket["status"]; label: string }[] = [
  { status: "new", label: "New" },
  { status: "in_progress", label: "In Progress" },
  { status: "waiting_on_client", label: "Waiting on Client" },
  { status: "resolved", label: "Resolved" },
  { status: "closed", label: "Closed" },
];

/**
 * Drag-and-drop Kanban board using @dnd-kit/core's DndContext. Keyboard
 * accessibility is intentionally preserved -- KeyboardSensor is included
 * alongside PointerSensor (the default @dnd-kit keyboard interaction: Tab to
 * a card's drag handle, Space to lift, Arrow keys to move between droppable
 * containers, Space to drop, Escape to cancel) per 03-CONTEXT.md's stated
 * @dnd-kit selection rationale -- do not remove this sensor.
 *
 * Only users with ticket:manage may drag; others (e.g. sales/finance, which
 * retain ticket:view only) get a read-only board -- draggable is computed
 * once from the current user's role and passed down to every card/column.
 */
export function KanbanBoard({
  tickets,
  currentUserRole,
}: {
  tickets: KanbanTicket[];
  currentUserRole: Role;
}) {
  const draggable = can(currentUserRole, "ticket:manage");

  const [items, setItems] = React.useState(tickets);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setItems(tickets);
  }, [tickets]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const columns = React.useMemo(() => {
    const map = new Map<string, KanbanTicket[]>(STATUS_COLUMNS.map((c) => [c.status, []]));
    for (const ticket of items) {
      map.get(ticket.status)?.push(ticket);
    }
    return map;
  }, [items]);

  const activeTicket = activeId ? items.find((t) => t.id === activeId) ?? null : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    if (!draggable) return;

    const { active, over } = event;
    if (!over) return;

    const ticketId = String(active.id);
    const ticket = items.find((t) => t.id === ticketId);
    if (!ticket) return;

    // `over.id` is either a column's status id (dropped on an empty area /
    // the column container) or another ticket's id (dropped onto a card) --
    // resolve to the destination column's status either way.
    const overId = String(over.id);
    const isColumnId = STATUS_COLUMNS.some((c) => c.status === overId);
    const newStatus = isColumnId ? overId : items.find((t) => t.id === overId)?.status;

    if (!newStatus || newStatus === ticket.status) return;

    const previous = items;
    setItems((current) =>
      current.map((t) => (t.id === ticketId ? { ...t, status: newStatus } : t)),
    );

    const result = await updateTicketStatus(ticketId, newStatus as never);
    if (result?.error) {
      // Roll back on failure (e.g. concurrent delete -- P2025).
      setItems(previous);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {STATUS_COLUMNS.map((col) => (
          <KanbanColumn
            key={col.status}
            status={col.status}
            label={col.label}
            tickets={columns.get(col.status) ?? []}
            draggable={draggable}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTicket ? <TicketCard ticket={activeTicket} draggable={draggable} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
