"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { TICKET_MANAGE_ROLES } from "@/lib/permissions";

/**
 * Adds a comment to a Ticket. Gated to TICKET_MANAGE_ROLES -- commenting is
 * part of working a ticket, same role set as manage (technician, dispatcher,
 * admin), per 03-CONTEXT.md's RBAC decisions. authorId is taken from the
 * current session (never trusted from form input). isInternal comes from
 * the form's internal-note checkbox.
 */
export async function addComment(ticketId: string, formData: FormData) {
  const user = await requireRole(TICKET_MANAGE_ROLES);

  const body = String(formData.get("body") ?? "").trim();
  const isInternal = formData.get("isInternal") === "on" || formData.get("isInternal") === "true";

  if (!body) {
    return { error: "Comment cannot be empty" };
  }

  await db.ticketComment.create({
    data: {
      ticketId,
      authorId: user.id,
      body,
      isInternal,
    },
  });

  revalidatePath(`/tickets/${ticketId}`);
  return { success: true };
}
