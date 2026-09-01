"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { TIME_ENTRY_MANAGE_ROLES } from "@/lib/permissions";
import { computeElapsedMinutes } from "@/lib/timer";
import { timeEntryUpdateSchema } from "@/lib/validations/time-entry";

const ALREADY_RUNNING_ERROR = "You already have a timer running. Stop it before starting a new one.";

/**
 * Starts a timer on a Ticket for the current user. Gated to
 * TIME_ENTRY_MANAGE_ROLES (technician, dispatcher, admin) -- see
 * 04-CONTEXT.md's RBAC decisions. A user may only have one running timer
 * (endedAt: null) at a time, across all tickets -- this is enforced both
 * at the app level here (pre-check) and at the DB level by a partial
 * unique index from 04-01 (caught below as P2002), so a two-tab race still
 * surfaces the same friendly structured error instead of a raw 500.
 * contractId is snapshotted from the ticket's current contractId at the
 * moment the timer starts (may be null -- a ticket with no contract is a
 * valid state, not an error) so that later billing reflects the contract
 * that was active while the work was performed, even if the ticket's
 * contract changes afterward.
 */
export async function startTimer(ticketId: string) {
  const user = await requireRole(TIME_ENTRY_MANAGE_ROLES);

  const existingRunning = await db.timeEntry.findFirst({
    where: { userId: user.id, endedAt: null },
  });

  if (existingRunning) {
    return { error: ALREADY_RUNNING_ERROR };
  }

  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { contractId: true },
  });

  if (!ticket) {
    return { error: "Ticket not found" };
  }

  try {
    await db.timeEntry.create({
      data: {
        ticketId,
        userId: user.id,
        contractId: ticket.contractId,
        startedAt: new Date(),
        endedAt: null,
        isBillable: true,
      },
    });
  } catch (err) {
    // Redundant backstop for the DB-level partial unique index (04-01) that
    // enforces "one running timer per user" at the database level -- a
    // two-tab race where both requests pass the pre-check above will have
    // exactly one succeed and the other hit P2002 here.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: ALREADY_RUNNING_ERROR };
    }
    throw err;
  }

  revalidatePath(`/tickets/${ticketId}`);
  return { success: true };
}

/**
 * Stops a running timer, computing durationMinutes via the shared
 * computeElapsedMinutes helper (@/lib/timer) so the server-side computation
 * matches the client's live display exactly. Gated to
 * TIME_ENTRY_MANAGE_ROLES. endedAt and durationMinutes are always set
 * together in the same update -- never one without the other. Refuses to
 * re-stop an already-stopped entry (returns a structured error rather than
 * overwriting endedAt/durationMinutes with a new value). Handles P2025 for
 * an entry deleted concurrently.
 */
export async function stopTimer(timeEntryId: string) {
  await requireRole(TIME_ENTRY_MANAGE_ROLES);

  const entry = await db.timeEntry.findUnique({ where: { id: timeEntryId } });

  if (!entry) {
    return { error: "Time entry not found" };
  }

  if (entry.endedAt !== null) {
    return { error: "Timer is already stopped" };
  }

  const endedAt = new Date();
  const durationMinutes = computeElapsedMinutes(entry.startedAt, endedAt);

  try {
    await db.timeEntry.update({
      where: { id: timeEntryId },
      data: { endedAt, durationMinutes },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Time entry not found" };
    }
    throw err;
  }

  revalidatePath(`/tickets/${entry.ticketId}`);
  return { success: true };
}

/**
 * Updates a TimeEntry's isBillable/notes fields only -- startedAt, endedAt,
 * durationMinutes, userId, and contractId are never touched here (those are
 * owned by startTimer/stopTimer). Gated to TIME_ENTRY_MANAGE_ROLES. Refuses
 * to edit an entry that has already been invoiced (invoiceLineItemId
 * non-null), checked before attempting the update so no partial state can
 * result. Handles P2025 for an entry deleted concurrently.
 */
export async function updateTimeEntry(id: string, formData: FormData) {
  await requireRole(TIME_ENTRY_MANAGE_ROLES);

  const parsed = timeEntryUpdateSchema.safeParse({
    isBillable: formData.get("isBillable") === "on" || formData.get("isBillable") === "true",
    notes: formData.get("notes") ? String(formData.get("notes")) : undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const entry = await db.timeEntry.findUnique({ where: { id } });

  if (!entry) {
    return { error: "Time entry not found" };
  }

  if (entry.invoiceLineItemId !== null) {
    return { error: "This time entry has already been invoiced and cannot be edited." };
  }

  const { isBillable, notes } = parsed.data;

  try {
    await db.timeEntry.update({
      where: { id },
      data: { isBillable, notes: notes ?? null },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Time entry not found" };
    }
    throw err;
  }

  revalidatePath(`/tickets/${entry.ticketId}`);
  return { success: true };
}

/**
 * Deletes a TimeEntry. Gated to TIME_ENTRY_MANAGE_ROLES. Same invoiced-entry
 * guard as updateTimeEntry -- an already-invoiced entry must never be
 * deleted out from under its InvoiceLineItem. Handles P2025 for an entry
 * deleted concurrently.
 */
export async function deleteTimeEntry(id: string) {
  await requireRole(TIME_ENTRY_MANAGE_ROLES);

  const entry = await db.timeEntry.findUnique({ where: { id } });

  if (!entry) {
    return { error: "Time entry not found" };
  }

  if (entry.invoiceLineItemId !== null) {
    return { error: "This time entry has already been invoiced and cannot be edited." };
  }

  try {
    await db.timeEntry.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Time entry not found" };
    }
    throw err;
  }

  revalidatePath(`/tickets/${entry.ticketId}`);
  return { success: true };
}
