"use server";

import { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { INVOICE_MANAGE_ROLES } from "@/lib/permissions";
import { computeContractCharges, type ContractBillingInput } from "@/lib/billing";
import { generateInvoiceSchema } from "@/lib/validations/invoice";
import { getValidQboClient } from "@/lib/qbo";

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

  // periodEnd is a plain yyyy-mm-dd date coerced to midnight of that day by
  // generateInvoiceSchema. Used as-is, a time entry started later that same
  // day would be silently excluded from the period (an exclusive-boundary
  // bug), even though a user picking "period end: 2026-08-31" expects that
  // whole day included. This inclusive-end adjustment is ONLY for the query
  // boundary below -- the original periodEnd (midnight) is still what gets
  // stored on the Invoice.periodEnd column further down, so the stored
  // record reflects the user's literal selected end date.
  const periodEndInclusive = new Date(periodEnd);
  periodEndInclusive.setHours(23, 59, 59, 999);

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
      startedAt: { gte: periodStart, lte: periodEndInclusive },
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

// NOTE: InvoiceStatus is a fixed Prisma enum with exactly three values --
// draft / finalized / pushed (see prisma/schema.prisma). Adding a fourth
// value (e.g. a dedicated "pushing" in-flight status) would require a schema
// migration, which is out of scope/forbidden for this plan. Instead, the
// atomic claim below uses the qboInvoiceId column itself as the claim
// marker: a conditional updateMany() sets qboInvoiceId to the literal
// sentinel string "PENDING" only if it is currently null (and status is
// still "finalized"), which is race-safe under Postgres's read-committed
// row-level locking for a single-row UPDATE ... WHERE. If exactly one row
// is affected, this request has exclusively claimed the invoice for
// pushing; qboInvoiceId is later overwritten with the real QBO invoice id
// on success, or reset back to null (releasing the claim) on failure.

interface QboLine {
  Amount: number;
  DetailType: "SalesItemLineDetail";
  Description: string;
  SalesItemLineDetail: {
    ItemRef: { value: string; name?: string };
  };
}

interface QboInvoicePayload {
  CustomerRef: { value: string };
  Line: QboLine[];
}

function getQboApiBaseUrl(): string {
  const environment = process.env.QBO_ENVIRONMENT;
  return environment === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

/**
 * Pushes a finalized Invoice to QuickBooks Online via the Accounting API's
 * Invoice-create endpoint. Manual, user-triggered only (called from the
 * "Push to QuickBooks" button) -- there is no scheduled/automatic push.
 *
 * Ordering is deliberate and matters for correctness: all pre-checks
 * (status, qboInvoiceId, company.qboCustomerId, QBO connection) run BEFORE
 * the atomic claim, and the atomic claim runs BEFORE any network call to
 * QBO. This guarantees a rejected/misconfigured invoice never reaches the
 * point of mutating state or calling out to QBO, and that two concurrent
 * pushes of the same invoice cannot both reach QBO (see the claim comment
 * above).
 */
export async function pushInvoiceToQbo(invoiceId: string) {
  await requireRole(INVOICE_MANAGE_ROLES);

  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      lineItems: true,
      company: true,
    },
  });

  if (!invoice) {
    return { error: "Invoice not found" };
  }

  if (invoice.status !== "finalized") {
    return { error: "Only finalized invoices can be pushed to QuickBooks" };
  }

  if (invoice.qboInvoiceId) {
    return { error: "This invoice has already been pushed to QuickBooks" };
  }

  if (!invoice.company.qboCustomerId) {
    return {
      error: "Company is not linked to a QuickBooks customer. Set it on the admin QuickBooks page.",
    };
  }

  const qboClient = await getValidQboClient();

  if (!qboClient) {
    return { error: "QuickBooks is not connected. Connect it on the admin QuickBooks page." };
  }

  // Atomic claim: closes the two-admin/double-click race. Only one
  // concurrent request can win this conditional update (where status is
  // still "finalized" AND qboInvoiceId is still null), since Postgres
  // serializes row-level UPDATEs. Everything before this line is a
  // read-only pre-check; everything after it (network call to QBO) only
  // happens for the single request that wins the claim.
  const claim = await db.invoice.updateMany({
    where: { id: invoiceId, status: "finalized", qboInvoiceId: null },
    data: { qboInvoiceId: "PENDING" },
  });

  if (claim.count !== 1) {
    return {
      error: "This invoice is already being pushed or has already been pushed. Refresh the page.",
    };
  }

  // Best-effort QBO Invoice payload shape. QBO's real Accounting API likely
  // requires each SalesItemLineDetail to reference a real ItemRef (an
  // Item entity id configured in the target QBO company) -- this codebase
  // has no Item-mapping concept, so ItemRef.value is hardcoded to "1"
  // (a placeholder/sentinel, commonly the default "Services" item in a
  // fresh QBO sandbox company) with the line's own description carried in
  // both the line Description and the ItemRef name. This has NOT been
  // verified against Intuit's live API docs -- flagged as a follow-up risk
  // in the plan summary, not a blocking issue for this plan's scope.
  const payload: QboInvoicePayload = {
    CustomerRef: { value: invoice.company.qboCustomerId },
    Line: invoice.lineItems.map((lineItem) => ({
      Amount: lineItem.amount.toNumber(),
      DetailType: "SalesItemLineDetail",
      Description: lineItem.description,
      SalesItemLineDetail: {
        ItemRef: { value: "1", name: lineItem.description },
      },
    })),
  };

  let qboResponse: Response;

  try {
    qboResponse = await fetch(
      `${getQboApiBaseUrl()}/v3/company/${qboClient.realmId}/invoice`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${qboClient.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
  } catch (err) {
    // Network-level failure (fetch itself threw) -- release the claim so
    // the invoice remains finalized/retryable, same treatment as a QBO API
    // error response.
    console.error(`QBO push failed for invoice ${invoiceId}: network error`, err);
    await db.invoice.update({
      where: { id: invoiceId },
      data: { qboInvoiceId: null },
    });
    return {
      error: "Could not reach QuickBooks. Check your network connection and try again.",
    };
  }

  if (qboResponse.status === 401) {
    // OAuth token rejected -- release the claim.
    console.error(`QBO push failed for invoice ${invoiceId}: 401 unauthorized`);
    await db.invoice.update({
      where: { id: invoiceId },
      data: { qboInvoiceId: null },
    });
    return { error: "QuickBooks authentication failed. Reconnect on the admin QuickBooks page." };
  }

  if (!qboResponse.ok) {
    // The push itself failed (QBO rejected the payload/request) -- release
    // the claim so the invoice remains finalized and retryable. Do not
    // leave the "PENDING" sentinel in place.
    const errorBody = await qboResponse.text().catch(() => "");
    console.error(
      `QBO push failed for invoice ${invoiceId}: ${qboResponse.status} ${qboResponse.statusText}`,
      errorBody,
    );
    await db.invoice.update({
      where: { id: invoiceId },
      data: { qboInvoiceId: null },
    });
    return {
      error: `QuickBooks rejected the invoice: ${errorBody || qboResponse.statusText}`,
    };
  }

  const qboData = (await qboResponse.json().catch(() => null)) as
    | { Invoice?: { Id?: string } }
    | null;
  const qboInvoiceRealId = qboData?.Invoice?.Id;

  if (!qboInvoiceRealId) {
    // QBO responded 2xx but without a parseable invoice id. This is
    // ambiguous (unlike a 401 or non-ok response, which are unambiguous
    // rejections), but leaving the "PENDING" claim in place would
    // permanently lock this invoice out of retry -- no code path resets
    // qboInvoiceId back to null once "PENDING" without this release, since
    // the claim's own `where: qboInvoiceId: null` clause would never match
    // it again. Release the claim so an admin can inspect and retry rather
    // than being stuck with an unrecoverable invoice.
    console.error(
      `QBO push for invoice ${invoiceId}: 2xx response but missing Invoice.Id`,
      qboData,
    );
    await db.invoice.update({
      where: { id: invoiceId },
      data: { qboInvoiceId: null },
    });
    return {
      error: "QuickBooks returned an unexpected response (missing invoice id). The invoice was not marked as pushed -- please verify in QuickBooks before retrying to avoid a possible duplicate.",
    };
  }

  // QBO call succeeded -- this is the distinct partial-failure path. If the
  // local update below fails, the invoice already exists in QuickBooks;
  // the claim (qboInvoiceId: "PENDING") must NOT be released, since
  // resetting it to null here would allow a retry to create a duplicate
  // invoice in QuickBooks.
  try {
    await db.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "pushed",
        qboInvoiceId: qboInvoiceRealId,
        qboPushedAt: new Date(),
      },
    });
  } catch (err) {
    console.error(
      `QBO invoice ${qboInvoiceRealId} created for local invoice ${invoiceId} but local update failed -- requires manual reconciliation:`,
      err,
    );
    return {
      error: `Invoice was created in QuickBooks (id: ${qboInvoiceRealId}) but the local record could not be updated to reflect this -- contact an admin before retrying, to avoid creating a duplicate in QuickBooks.`,
    };
  }

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
  return { success: true };
}
