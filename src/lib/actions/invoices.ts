"use server";

import { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { INVOICE_MANAGE_ROLES } from "@/lib/permissions";
import { computeContractCharges, type ContractBillingInput } from "@/lib/billing";
import { generateInvoiceSchema } from "@/lib/validations/invoice";

/**
 * Resolves "the company's active contract" using the exact deterministic
 * rule locked in 03-CONTEXT.md's "Active-contract resolution rule" and
 * re-derived identically here (per this plan's stop-gate instructions,
 * since src/lib/actions/tickets.ts's resolveActiveContract is not exported
 * and this is a different file): among the company's contracts where
 * endDate IS NULL OR endDate >= now(), order by startDate DESC, id DESC and
 * take the first row. This rule is shared verbatim with tickets.ts and
 * Plan 03-03's email poller -- do not reword or reimplement differently
 * here. Returns null if zero contracts match.
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
 * Generates a new draft Invoice for a company/date range. Gated to
 * INVOICE_MANAGE_ROLES (finance, admin) per 04-CONTEXT.md's RBAC decisions.
 *
 * Billing-correctness is the highest-risk part of this action: block-hour
 * contracts bill against a CUMULATIVE LIFETIME allotment (see
 * src/lib/billing.ts's module doc and 04-CONTEXT.md's "User decision on
 * block-hour proration"), not a per-invoice-period reset. This function is
 * solely responsible for summing that lifetime prior-invoiced total before
 * calling computeContractCharges -- billing.ts performs no DB access itself.
 */
export async function generateInvoice(formData: FormData) {
  await requireRole(INVOICE_MANAGE_ROLES);

  const parsed = generateInvoiceSchema.safeParse({
    companyId: formData.get("companyId"),
    periodStart: formData.get("periodStart"),
    periodEnd: formData.get("periodEnd"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { companyId, periodStart, periodEnd } = parsed.data;

  const contract = await resolveActiveContract(companyId);

  if (!contract) {
    return { error: "Company has no active contract" };
  }

  // Current period's billable, uninvoiced, stopped time entries for this
  // contract. Only entries with endedAt set (timer stopped) and
  // invoiceLineItemId null (not already consumed by a prior invoice) are
  // eligible.
  const currentPeriodEntries = await db.timeEntry.findMany({
    where: {
      contractId: contract.id,
      isBillable: true,
      invoiceLineItemId: null,
      endedAt: { not: null },
      startedAt: { gte: periodStart, lte: periodEnd },
    },
  });

  const currentPeriodBillableMinutes = currentPeriodEntries.reduce(
    (sum, entry) => sum + (entry.durationMinutes ?? 0),
    0,
  );
  const consumedEntryIds = currentPeriodEntries.map((entry) => entry.id);

  // Decimal-typed Contract fields must be converted to plain numbers before
  // ever being passed into computeContractCharges -- billing.ts's
  // ContractBillingInput doc explicitly requires this and performs no
  // Decimal-aware conversion itself. blockHours is already a plain Int
  // column and needs no conversion.
  const contractBillingInput: ContractBillingInput = {
    billingType: contract.billingType,
    blockHours: contract.blockHours,
    flatFeeAmount: contract.flatFeeAmount !== null ? contract.flatFeeAmount.toNumber() : null,
    hourlyRate: contract.hourlyRate !== null ? contract.hourlyRate.toNumber() : null,
  };

  if (
    contract.billingType === "block_hour" &&
    (contractBillingInput.blockHours === null || contractBillingInput.hourlyRate === null)
  ) {
    return {
      error: "Contract is misconfigured for block-hour billing: blockHours and hourlyRate must both be set.",
    };
  }

  // ASSUMPTION (locked in 04-CONTEXT.md's Contract deletion policy): this
  // cumulative sum is only correct if Contracts with billing history are
  // never deleted, only updated in place or superseded by a new Contract
  // row for renewals. If a Contract is deleted after being invoiced
  // against, its TimeEntry/Invoice rows' contractId is set to null
  // (onDelete: SetNull), silently removing that history from this sum.
  // This function does not and cannot enforce that policy -- it is an
  // operational assumption, not a code invariant.
  const priorInvoicedAggregate = await db.timeEntry.aggregate({
    where: { contractId: contract.id, invoiceLineItemId: { not: null } },
    _sum: { durationMinutes: true },
  });
  const priorInvoicedBillableMinutes = priorInvoicedAggregate._sum.durationMinutes ?? 0;

  const charge = computeContractCharges(
    contractBillingInput,
    currentPeriodBillableMinutes,
    priorInvoicedBillableMinutes,
  );

  const isFlatFee = contract.billingType === "flat_fee";

  if (!isFlatFee && currentPeriodEntries.length === 0 && charge.amount === 0) {
    return { error: "No billable time entries found in this date range" };
  }

  let invoiceId: string;

  try {
    invoiceId = await db.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          companyId,
          contractId: contract.id,
          periodStart,
          periodEnd,
          status: "draft",
          subtotal: charge.amount,
          total: charge.amount,
        },
      });

      const lineItem = await tx.invoiceLineItem.create({
        data: {
          invoiceId: invoice.id,
          description: charge.description,
          quantity: charge.quantity,
          unitRate: charge.unitRate,
          amount: charge.amount,
        },
      });

      // Immediately before stamping, re-check that none of the consumed
      // entries were claimed by a concurrent generateInvoice call since the
      // initial query above. If the count differs, another request beat us
      // to some of these entries -- throw to roll back the whole
      // transaction (including the Invoice/InvoiceLineItem just created).
      const stillUnclaimed = await tx.timeEntry.findMany({
        where: { id: { in: consumedEntryIds }, invoiceLineItemId: null },
        select: { id: true },
      });

      if (stillUnclaimed.length !== consumedEntryIds.length) {
        throw new Error("CONCURRENT_INVOICE_CONFLICT");
      }

      const stampResult = await tx.timeEntry.updateMany({
        where: { id: { in: consumedEntryIds }, invoiceLineItemId: null },
        data: { invoiceLineItemId: lineItem.id },
      });

      // Defense-in-depth: even after the re-check passed, verify the
      // update actually claimed every entry. If not, roll back rather than
      // leaving a partially-stamped, inconsistent state.
      if (stampResult.count !== consumedEntryIds.length) {
        throw new Error("CONCURRENT_INVOICE_CONFLICT");
      }

      return invoice.id;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "CONCURRENT_INVOICE_CONFLICT") {
      return {
        error: "Some time entries in this period were invoiced by a concurrent request. Please retry.",
      };
    }
    throw err;
  }

  revalidatePath("/invoices");
  redirect(`/invoices/${invoiceId}`);
}

/**
 * Transitions an Invoice from draft to finalized. Gated to
 * INVOICE_MANAGE_ROLES. Only a draft invoice may be finalized -- an
 * already-finalized or pushed invoice returns a structured error rather
 * than silently no-op'ing or throwing. Handles P2025 for an invoice deleted
 * concurrently.
 */
export async function finalizeInvoice(invoiceId: string) {
  await requireRole(INVOICE_MANAGE_ROLES);

  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });

  if (!invoice) {
    return { error: "Invoice not found" };
  }

  if (invoice.status !== "draft") {
    return { error: "Only draft invoices can be finalized" };
  }

  try {
    await db.invoice.update({
      where: { id: invoiceId },
      data: { status: "finalized" },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Invoice not found" };
    }
    throw err;
  }

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
  return { success: true };
}
