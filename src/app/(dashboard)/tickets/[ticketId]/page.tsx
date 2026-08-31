import { redirect, notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { SlaBadge } from "@/components/tickets/sla-badge";
import { TicketCommentForm } from "@/components/tickets/ticket-comment-form";
import { AssignmentControl } from "@/components/tickets/ticket-form";

/**
 * Ticket detail page (/tickets/[ticketId]). Gated with can(user.role,
 * "ticket:view") -- every role with view access (all 5 roles) may reach
 * this page. Self-fetches the ticket with all relations plus comments
 * (ordered createdAt asc), renders SlaBadge (the single shared SLA-status
 * implementation), the full comment list (no isInternal filtering -- there
 * is no external portal in this phase's scope, so all ticket:view users may
 * see internal comments per this plan's explicit instruction), a comment
 * form gated to ticket:manage, and an assignment control gated to
 * ticket:assign.
 *
 * params is a Promise in this Next.js version (App Router dynamic segment
 * convention) -- must be awaited before use, matching the established
 * pattern in src/app/(dashboard)/clients/[companyId]/page.tsx.
 */
export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { ticketId } = await params;

  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  if (!can(user.role, "ticket:view")) {
    redirect("/unauthorized");
  }

  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: {
      company: { select: { id: true, name: true } },
      contact: { select: { id: true, name: true } },
      asset: { select: { id: true, name: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
      contract: { select: { id: true, billingType: true } },
      comments: {
        orderBy: { createdAt: "asc" },
        include: { author: { select: { id: true, name: true, email: true } } },
      },
    },
  });

  if (!ticket) {
    notFound();
  }

  const users = can(user.role, "ticket:assign")
    ? await db.user.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, email: true },
      })
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold">{ticket.subject}</h1>
          <Badge variant="outline">{ticket.status.replace(/_/g, " ")}</Badge>
          <Badge variant="secondary">{ticket.priority}</Badge>
          <SlaBadge ticket={ticket} />
        </div>
        <p className="text-sm text-muted-foreground">
          {ticket.company.name}
          {ticket.contact ? ` · ${ticket.contact.name}` : ""}
          {ticket.asset ? ` · ${ticket.asset.name}` : ""}
        </p>
      </div>

      <div className="flex flex-col gap-2 rounded-md border p-4">
        <h2 className="text-sm font-semibold">Description</h2>
        <p className="whitespace-pre-wrap text-sm">{ticket.description}</p>
      </div>

      {can(user.role, "ticket:assign") && (
        <div className="max-w-xs">
          <AssignmentControl
            ticketId={ticket.id}
            assignedToId={ticket.assignedToId}
            users={users}
          />
        </div>
      )}

      {!can(user.role, "ticket:assign") && (
        <p className="text-sm text-muted-foreground">
          Assigned to: {ticket.assignedTo ? ticket.assignedTo.name ?? ticket.assignedTo.email : "Unassigned"}
        </p>
      )}

      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Comments</h2>
        {ticket.comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {ticket.comments.map((comment) => (
              <li key={comment.id} className="flex flex-col gap-1 rounded-md border p-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {comment.author?.name ?? comment.author?.email ?? "System"}
                  </span>
                  <span>{comment.createdAt.toLocaleString()}</span>
                  {comment.isInternal && <Badge variant="outline">Internal</Badge>}
                </div>
                <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
              </li>
            ))}
          </ul>
        )}

        {can(user.role, "ticket:manage") && <TicketCommentForm ticketId={ticket.id} />}
      </div>
    </div>
  );
}
