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
 * Bounds how long deleteTicket may BLOCK on the row lock it takes below,
 * before failing fast with a message an admin can act on.
 *
 * This exists because of a lesson already measured in
 * src/lib/actions/users.ts (see withAdminInvariantLock): Prisma's own
 * `timeout` transaction option is a deadline checked BETWEEN statements and
 * cannot interrupt a statement already blocked inside Postgres. Without
 * `SET LOCAL lock_timeout`, a contended waiter blocks for as long as the
 * other transaction takes and then surfaces as an unhandled P2028 --
 * "Something went wrong" -- on a destructive path. With it, contention
 * surfaces as a clean SQLSTATE 55P03 that isDeleteLockContention() below
 * turns into a real sentence.
 *
 * Set well below the transaction `timeout` so 55P03 always wins the race to
 * report the problem.
 */
const TICKET_DELETE_LOCK_TIMEOUT_MS = 3_000;

/**
 * Postgres SQLSTATEs that mean "another transaction was holding the rows",
 * not "this code is broken".
 *
 *  - 55P03 lock_not_available: `SET LOCAL lock_timeout` fired while waiting
 *    for the FOR UPDATE below. The expected contention outcome.
 *  - 40P01 deadlock_detected: the residual risk documented in deleteTicket's
 *    docstring. Postgres breaks the cycle by aborting one transaction; if we
 *    are the victim, this is the code we see. It is a retryable outcome, not
 *    a fault, and must not reach an admin as a generic failure.
 */
const DELETE_CONTENTION_SQLSTATES = ["55P03", "40P01"] as const;

/**
 * Recursively looks for one of DELETE_CONTENTION_SQLSTATES in a Prisma error's
 * `meta`.
 *
 * A flat `meta.code` check is NOT sufficient on this stack (Prisma 7.10 +
 * @prisma/adapter-pg): src/lib/actions/users.ts's hasLockTimeoutCode measured
 * the SQLSTATE arriving nested as
 * `meta.driverAdapterError.cause.code`. That nesting is a driver-adapter
 * implementation detail with no stability guarantee, so this walks the object
 * rather than hard-coding the path. Depth is capped, which also makes a
 * cyclic structure safe.
 *
 * DUPLICATED, NOT SHARED, from users.ts: that module's copy is not exported
 * and this plan owns only this file. Extracting one helper both modules
 * import is a worthwhile follow-up, not something to do from here.
 */
function hasContentionSqlState(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  const codes: readonly string[] = DELETE_CONTENTION_SQLSTATES;

  if (
    (typeof record.code === "string" && codes.includes(record.code)) ||
    (typeof record.originalCode === "string" && codes.includes(record.originalCode))
  ) {
    return true;
  }

  return Object.values(record).some((child) => hasContentionSqlState(child, depth + 1));
}

/**
 * True for the failure shapes that mean "someone else held this ticket's time
 * entries", as opposed to a genuine bug.
 *
 * The only statement in deleteTicket that can WAIT on another transaction is
 * the raw `SELECT ... FOR UPDATE`, and a raw query's database error arrives as
 * P2010 carrying the SQLSTATE. The `tx.ticket.delete` that follows re-acquires
 * locks this transaction already holds, so it does not introduce a second
 * waiting point. P2028 is kept as a belt: if a future edit removes
 * lock_timeout or raises it past the transaction `timeout`, contention
 * degrades to Prisma's own deadline instead of to an unhandled crash.
 *
 * Anything else is re-thrown. This must never swallow a real error into a
 * "try again" message an admin would then retry forever.
 */
function isDeleteLockContention(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (err.code === "P2028") {
    return true;
  }

  if (err.code === "P2010") {
    return (
      hasContentionSqlState(err.meta) ||
      DELETE_CONTENTION_SQLSTATES.some((code) => err.message.includes(code))
    );
  }

  return false;
}

const DELETE_CONTENTION_ERROR =
  "This ticket's time entries are being invoiced right now. Try again in a moment.";

/**
 * Refusal used when an invoiced time entry exists but the invoice behind it
 * cannot be resolved for the message.
 *
 * Deliberately NOT reachable today -- see deleteTicket's "FAILS CLOSED" note.
 * It is the deny-by-default half of a decision that must never degrade from
 * "refuse" to "delete", and it is worded distinctly so that if it ever does
 * appear in a bug report, the schema change that made it reachable is obvious.
 */
const UNNAMEABLE_INVOICE_ERROR =
  "Cannot delete: time on this ticket is already billed, but the invoice could not be " +
  "identified. Void or adjust that invoice first.";

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
 * WHY THE CHECK AND THE DELETE ARE ONE LOCKED TRANSACTION.
 * Reading "is any entry invoiced?" and then deleting in a second round trip
 * is not a guard, it is a suggestion. generateInvoice (src/lib/actions/
 * invoices.ts) runs a transaction that creates an Invoice + InvoiceLineItem
 * and then `updateMany`s invoiceLineItemId onto the consumed time entries. If
 * it commits between the two round trips, the delete cascades away the
 * freshly-stamped entries and leaves an invoice whose subtotal and total are
 * backed by nothing -- raised silently, and exactly the corruption this guard
 * exists to prevent.
 *
 * A bare `db.$transaction` does NOT close that window. Prisma interactive
 * transactions on Postgres run at READ COMMITTED, which has no predicate
 * locking; src/lib/actions/users.ts's withAdminInvariantLock documents that at
 * length, with measurements. The mechanism here is instead an explicit
 * `SELECT ... FOR UPDATE` over this ticket's TimeEntry rows, taken as the
 * first statement:
 *
 *  - If we get there first, generateInvoice's `updateMany` BLOCKS on those
 *    rows until we commit. When it resumes, the rows are gone, its own
 *    `stampResult.count` assertion fails and it raises
 *    CONCURRENT_INVOICE_CONFLICT and rolls the whole invoice back -- an
 *    existing, already-tested conflict path, not a new one.
 *  - If generateInvoice gets there first, we block until it commits; the
 *    findFirst below is then a new statement taking a fresh READ COMMITTED
 *    snapshot, so it sees the stamped invoiceLineItemId and refuses.
 *
 * pg_advisory_xact_lock (withAdminInvariantLock's mechanism) was considered
 * and rejected for this one: an advisory lock is COOPERATIVE and only excludes
 * code taking the same key. generateInvoice takes no such key and is not this
 * module's to change, so a ticket-keyed advisory lock would serialize
 * concurrent deletes while leaving the delete-vs-invoice race -- the actual
 * hazard -- wide open.
 *
 * DEADLOCK RISK, stated rather than hidden. Both transactions take row locks
 * on the same TimeEntry rows, and Postgres locks rows in scan order, which the
 * two statements need not agree on. `ORDER BY "id"` below makes OUR order
 * deterministic; generateInvoice's `updateMany ... WHERE id IN (...)` has no
 * ORDER BY, and making it agree would mean editing a file this plan does not
 * own. So a cycle remains possible when one invoice run spans several of one
 * ticket's entries. Two things bound it: the lock footprint is UNCHANGED by
 * this fix (the cascading DELETE already locked every one of these rows, in an
 * order equally unspecified), and each transaction has exactly one waiting
 * statement, so a cycle needs both to interleave inside a window measured in
 * milliseconds. If it happens, Postgres detects it and aborts one side with
 * SQLSTATE 40P01, which isDeleteLockContention() turns into a retry message
 * rather than a 500. Aligning generateInvoice's stamping order is the real
 * fix and belongs with that file.
 *
 * FAILS CLOSED. The decision to refuse is made on `invoicedEntry` -- "does an
 * invoiced entry exist" -- and nothing else. Only the WORDING of the refusal
 * depends on resolving invoiceLineItem.invoice, and an unresolvable chain
 * degrades to UNNAMEABLE_INVOICE_ERROR rather than to a permitted delete. The
 * chain is non-nullable today (InvoiceLineItem.invoice is a required relation,
 * and the query already filters invoiceLineItemId to non-null), so the
 * degraded branch is unreachable -- but branching on the resolved invoice
 * would mean that making it nullable later silently converts this guard into
 * an irreversible cascading delete, with no test failing. This is the one
 * branch where the default matters most.
 *
 * WHAT THIS GUARD DOES NOT COVER, all deliberate:
 *  - INVOICED TIME ONLY. Uninvoiced billable time on this ticket is still
 *    destroyed silently by the cascade. "Refuse if any time is logged" was
 *    considered and rejected: it would make a mistyped ticket undeletable the
 *    moment anyone started a timer on it, for no billing-integrity gain, since
 *    uninvoiced time is not yet money. Recorded as a chosen trade-off, not an
 *    oversight.
 *  - NO AUDIT RECORD. There is no soft delete, no archive and no log line:
 *    after this commits, nothing anywhere records that this ticket existed or
 *    who removed it. ROADMAP Phase 11 (Delete Safety & Audit Trail) owns
 *    that, along with the same guard for deleteCompany.
 *  - PHANTOM ROWS. FOR UPDATE locks rows that exist when it runs, not rows
 *    inserted afterwards. A TimeEntry created on this ticket AND invoiced
 *    inside our transaction's window is not covered. It would have to be
 *    uninvoiced at creation, so it falls under the first bullet anyway.
 *
 * The invoiced-time query runs BEFORE tx.ticket.delete so a refused admin
 * gets the billing error rather than a generic not-found; a
 * concurrently-deleted or nonexistent ticket still falls through to the
 * existing P2025 "Ticket not found" path. redirect() throws a control-flow
 * signal, so it stays outside both the transaction callback and the
 * try/catch -- inside either, it would abort the transaction and roll the
 * delete back. Redirects to the Kanban board on success.
 */
export async function deleteTicket(id: string) {
  await requireRole(ADMIN_MANAGE_ROLES);

  let refusal: { error: string } | null;

  try {
    refusal = await db.$transaction(
      async (tx) => {
        // Bound the LOCK WAIT itself, before taking the lock.
        //
        // $executeRawUnsafe because `SET LOCAL` takes a literal, not a bind
        // parameter. The interpolated value is a numeric module constant and
        // never reaches this function from a caller.
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${TICKET_DELETE_LOCK_TIMEOUT_MS}`);

        // Must be the FIRST statement after the timeout is set: the rows have
        // to be locked before they are read, or the read is exactly the
        // unserialized check this replaces. `${id}` is a bind parameter (a
        // tagged template), not string interpolation.
        await tx.$executeRaw`
          SELECT "id" FROM "TimeEntry" WHERE "ticketId" = ${id} ORDER BY "id" FOR UPDATE
        `;

        const invoicedEntry = await tx.timeEntry.findFirst({
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

        // The refusal decision is `invoicedEntry`, full stop -- see "FAILS
        // CLOSED" above. Resolving the invoice only chooses the wording.
        if (invoicedEntry) {
          const invoice = invoicedEntry.invoiceLineItem?.invoice;

          if (!invoice) {
            return { error: UNNAMEABLE_INVOICE_ERROR };
          }

          const periodStart = invoicePeriodFormatter.format(invoice.periodStart);
          const periodEnd = invoicePeriodFormatter.format(invoice.periodEnd);

          return {
            error:
              `Cannot delete: time on this ticket is billed to ${invoice.company.name}'s invoice ` +
              `for ${periodStart} - ${periodEnd} (${invoice.status}). Void or adjust that invoice first.`,
          };
        }

        await tx.ticket.delete({ where: { id } });

        return null;
      },
      // `timeout` cannot interrupt a statement already blocked in Postgres --
      // TICKET_DELETE_LOCK_TIMEOUT_MS is what actually bounds the wait, and is
      // set well below this ceiling. See users.ts's corrected note.
      { maxWait: 5_000, timeout: 10_000 },
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Ticket not found" };
    }

    if (isDeleteLockContention(err)) {
      return { error: DELETE_CONTENTION_ERROR };
    }

    throw err;
  }

  if (refusal) {
    return refusal;
  }

  revalidatePath("/tickets");
  redirect("/tickets");
}
