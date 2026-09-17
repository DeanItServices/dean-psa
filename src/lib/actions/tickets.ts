"use server";

import { Prisma } from "@prisma/client";
import type { TicketStatus } from "@prisma/client";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { ADMIN_MANAGE_ROLES, TICKET_MANAGE_ROLES, TICKET_ASSIGN_ROLES } from "@/lib/permissions";
import { computeSlaDeadlines } from "@/lib/sla";
import { ticketSchema, ticketUpdateSchema } from "@/lib/validations/ticket";

/**
 * Resolves "the company's active contract" using the exact deterministic
 * rule locked in 03-CONTEXT.md's "Active-contract resolution rule": among
 * the company's contracts where endDate IS NULL OR endDate >= now(), order
 * by startDate DESC, id DESC and take the first row. This rule is shared
 * verbatim with Plan 03-03's email poller -- do not reword or reimplement
 * differently here. Returns null if zero contracts match (proceeding with
 * contractId: null is correct, not an error).
 */
async function resolveActiveContract(companyId: string) {
  const now = new Date();

  const contract = await db.contract.findFirst({
    where: {
      companyId,
      OR: [{ endDate: null }, { endDate: { gte: now } }],
    },
    orderBy: [{ startDate: "desc" }, { id: "desc" }],
  });

  return contract;
}

/**
 * Creates a new Ticket. Gated to TICKET_MANAGE_ROLES (technician,
 * dispatcher, admin) -- see 03-CONTEXT.md's RBAC decisions. If contractId is
 * not explicitly provided, resolves the company's active contract via the
 * shared deterministic rule and snapshots it onto the ticket. SLA deadlines
 * are computed once here (computeSlaDeadlines from @/lib/sla) and stored --
 * never recomputed live. Redirects to the new ticket's detail page on
 * success.
 */
export async function createTicket(formData: FormData) {
  const user = await requireRole(TICKET_MANAGE_ROLES);

  const parsed = ticketSchema.safeParse({
    companyId: formData.get("companyId"),
    contactId: formData.get("contactId") || undefined,
    assetId: formData.get("assetId") || undefined,
    assignedToId: formData.get("assignedToId") || undefined,
    contractId: formData.get("contractId") || undefined,
    status: formData.get("status") || "new",
    priority: formData.get("priority") || "normal",
    subject: formData.get("subject"),
    description: formData.get("description"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { companyId, contactId, assetId, assignedToId, contractId, status, priority, subject, description } =
    parsed.data;

  // Only dispatcher/admin (TICKET_ASSIGN_ROLES) may set the assignee at creation time --
  // this mirrors the dedicated assignTicket action's stricter gate. A technician (who is
  // in TICKET_MANAGE_ROLES but not TICKET_ASSIGN_ROLES) submitting an assignedToId is
  // silently ignored rather than rejected, so ticket creation still succeeds.
  const canAssignOnCreate = TICKET_ASSIGN_ROLES.includes(user.role);
  const resolvedAssignedToId = canAssignOnCreate ? (assignedToId ?? null) : null;

  let resolvedContractId = contractId ?? null;
  let contract = null;

  if (resolvedContractId) {
    contract = await db.contract.findUnique({ where: { id: resolvedContractId } });
  } else {
    contract = await resolveActiveContract(companyId);
    resolvedContractId = contract?.id ?? null;
  }

  const now = new Date();
  const { slaResponseDeadline, slaResolutionDeadline } = computeSlaDeadlines(
    contract
      ? { slaResponseMinutes: contract.slaResponseMinutes, slaResolutionMinutes: contract.slaResolutionMinutes }
      : null,
    now,
  );

  const ticket = await db.ticket.create({
    data: {
      companyId,
      contactId: contactId ?? null,
      assetId: assetId ?? null,
      assignedToId: resolvedAssignedToId,
      contractId: resolvedContractId,
      status,
      priority,
      source: "manual",
      subject,
      description,
      slaResponseDeadline,
      slaResolutionDeadline,
    },
  });

  redirect(`/tickets/${ticket.id}`);
}

/**
 * Updates a Ticket's subject/description/priority/company/contact/asset in
 * place. Does NOT change status or assignedToId -- those are handled by the
 * dedicated updateTicketStatus and assignTicket actions below, each with
 * their own semantics (SLA/resolvedAt bookkeeping, and the stricter
 * TICKET_ASSIGN_ROLES gate respectively). Same RBAC gate as createTicket.
 */
export async function updateTicket(id: string, formData: FormData) {
  await requireRole(TICKET_MANAGE_ROLES);

  const parsed = ticketUpdateSchema.safeParse({
    companyId: formData.get("companyId"),
    contactId: formData.get("contactId") || undefined,
    assetId: formData.get("assetId") || undefined,
    priority: formData.get("priority") || "normal",
    subject: formData.get("subject"),
    description: formData.get("description"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { companyId, contactId, assetId, priority, subject, description } = parsed.data;

  try {
    await db.ticket.update({
      where: { id },
      data: {
        companyId,
        contactId: contactId ?? null,
        assetId: assetId ?? null,
        priority,
        subject,
        description,
      },
    });

    revalidatePath(`/tickets/${id}`);
    revalidatePath("/tickets");
    return { success: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Ticket not found" };
    }
    throw err;
  }
}

/**
 * Updates a Ticket's status (drives the Kanban board's drag-to-reassign
 * interaction). Same RBAC gate as createTicket/updateTicket -- status
 * changes are part of working a ticket, not a dispatch-only action. Sets
 * resolvedAt when transitioning INTO resolved/closed, and clears it back to
 * null when transitioning back OUT of those states to an open status (a
 * reopened ticket is not "resolved"). Handles P2025 (ticket deleted
 * concurrently) by returning a structured error instead of throwing.
 */
export async function updateTicketStatus(id: string, status: TicketStatus) {
  await requireRole(TICKET_MANAGE_ROLES);

  const isClosingStatus = status === "resolved" || status === "closed";

  try {
    await db.ticket.update({
      where: { id },
      data: {
        status,
        resolvedAt: isClosingStatus ? new Date() : null,
      },
    });

    revalidatePath(`/tickets/${id}`);
    revalidatePath("/tickets");
    return { success: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Ticket not found" };
    }
    throw err;
  }
}

/**
 * Assigns (or unassigns, when assignedToId is null) a Ticket to a
 * technician. Gated to TICKET_ASSIGN_ROLES (dispatcher, admin) -- NOT
 * TICKET_MANAGE_ROLES -- assignment/triage is dispatch's role per
 * 03-CONTEXT.md, distinct from the broader "manage" gate that also includes
 * technicians. Handles P2025 by returning a structured error.
 */
export async function assignTicket(id: string, assignedToId: string | null) {
  await requireRole(TICKET_ASSIGN_ROLES);

  try {
    await db.ticket.update({
      where: { id },
      data: { assignedToId },
    });

    revalidatePath(`/tickets/${id}`);
    revalidatePath("/tickets");
    return { success: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Ticket not found" };
    }
    throw err;
  }
}

/** Invoice periods are rendered with a fixed locale so the refusal message below
 * is deterministic rather than dependent on the server's locale. Matches the
 * "en-US"/medium convention used by the contracts and reports views. */
const invoicePeriodFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/**
 * Deletes a Ticket. Gated to ADMIN_MANAGE_ROLES -- admin only. This is
 * deliberately narrower than the TICKET_MANAGE_ROLES gate on
 * createTicket/updateTicket, and it supersedes the technician-ownership
 * model this action used to implement. Deleting a ticket destroys billing
 * history, so the action is restricted to the role accountable for that
 * data: technicians close tickets, they don't delete them.
 *
 * requireRole REDIRECTS (to /unauthorized) rather than returning an error,
 * so an unauthorized caller never reaches this body. Nothing here, and no
 * caller, can surface a "not allowed" message from a return value -- there
 * is no return value to inspect.
 *
 * The delete cascades to BOTH of the ticket's children: its TicketComments
 * and its TimeEntries (each declares onDelete: Cascade on its `ticket`
 * relation -- see model TicketComment and model TimeEntry). The TimeEntry
 * cascade is the dangerous one. TimeEntry.invoiceLineItem is nullable and
 * declared onDelete: SetNull, so the database neither blocks this delete nor
 * propagates it upward: InvoiceLineItem rows hang off Invoice, survive
 * untouched, and the invoice keeps its subtotal and total while the time
 * records justifying those amounts quietly disappear. That is billing-history
 * corruption with no error anywhere, which is why this action refuses up
 * front when any of the ticket's time entries is already invoiced. model
 * Invoice has no invoice-number field, so the refusal names the invoice by
 * the fields that exist and mean something to an admin: company, period and
 * status.
 *
 * The invoiced-time query runs BEFORE db.ticket.delete so a refused admin
 * gets the billing error rather than a generic not-found; a
 * concurrently-deleted or nonexistent ticket still falls through to the
 * existing P2025 "Ticket not found" path. Redirects to the Kanban board on
 * success.
 */
export async function deleteTicket(id: string) {
  await requireRole(ADMIN_MANAGE_ROLES);

  const invoicedEntry = await db.timeEntry.findFirst({
    where: { ticketId: id, invoiceLineItemId: { not: null } },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    select: {
      invoiceLineItem: {
        select: {
          invoice: {
            select: {
              status: true,
              periodStart: true,
              periodEnd: true,
              company: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const invoice = invoicedEntry?.invoiceLineItem?.invoice;

  if (invoice) {
    const periodStart = invoicePeriodFormatter.format(invoice.periodStart);
    const periodEnd = invoicePeriodFormatter.format(invoice.periodEnd);

    return {
      error:
        `Cannot delete: time on this ticket is billed to ${invoice.company.name}'s invoice ` +
        `for ${periodStart} - ${periodEnd} (${invoice.status}). Void or adjust that invoice first.`,
    };
  }

  try {
    await db.ticket.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Ticket not found" };
    }
    throw err;
  }

  revalidatePath("/tickets");
  redirect("/tickets");
}
