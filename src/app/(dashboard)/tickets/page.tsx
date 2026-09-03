import Link from "next/link";
import { redirect } from "next/navigation";
import { requireActiveUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { KanbanBoard } from "@/components/tickets/kanban-board";

/**
 * Kanban board (/tickets) -- the primary daily-use ticketing surface.
 * View-gated by can(role, "ticket:view") directly (NOT requireRole, which
 * would incorrectly exclude sales/finance who have view-only access) --
 * per this plan's "Required interfaces/content structure". Self-fetches all
 * tickets via db.ticket.findMany with the relations the board/cards need
 * (assignedTo, company).
 */
export default async function TicketsPage() {
  // requireActiveUser(), not getCurrentUser(): a shared layout does not
  // re-render on a soft navigation, so the inactive / mustChangePassword gate
  // has to run in the leaf too. See src/lib/session.ts. It also subsumes the
  // !user -> /login redirect this page used to open-code.
  const user = await requireActiveUser();

  if (!can(user.role, "ticket:view")) {
    redirect("/unauthorized");
  }

  const tickets = await db.ticket.findMany({
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
      company: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tickets</h1>
        {can(user.role, "ticket:manage") && (
          <Button asChild>
            <Link href="/tickets/new">New Ticket</Link>
          </Button>
        )}
      </div>

      <KanbanBoard tickets={tickets} currentUserRole={user.role} />
    </div>
  );
}
