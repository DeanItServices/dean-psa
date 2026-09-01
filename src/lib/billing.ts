/**
 * Pure contract-billing charge computation. No database access, no
 * "use server", no side effects -- consumed by Plan 04-05's invoice
 * generation Server Action, which is solely responsible for querying the
 * Contract/TimeEntry data and summing `priorInvoicedBillableMinutes` from
 * historical `InvoiceLineItem`/`TimeEntry` records before calling
 * `computeContractCharges` for a block-hour contract. This module never
 * queries the database itself.
 *
 * Implements the CUMULATIVE-LIFETIME block-hour rule locked in during
 * Phase 4 planning (see 04-CONTEXT.md "User decision on block-hour
 * proration"): `Contract.blockHours` is a lifetime allotment, not a
 * per-invoice-period allotment. Overage is computed against the running
 * total of all billable minutes ever invoiced against the contract plus
 * the current period's minutes -- never a per-period reset.
 *
 * No tax or discount logic is implemented here (out of Phase 4 scope).
 */

/**
 * Prisma's `Decimal` fields (`flatFeeAmount`, `hourlyRate`) serialize to a
 * Decimal.js-like object at runtime, not a plain `number`. Callers MUST
 * convert those fields (e.g. via `.toNumber()`) before constructing this
 * input -- this module performs no Decimal-aware conversion itself.
 */
export type ContractBillingInput = {
  billingType: "block_hour" | "flat_fee" | "hourly_breakfix";
  blockHours: number | null;
  flatFeeAmount: number | string | null;
  hourlyRate: number | string | null;
};

export type BillingChargeResult = {
  quantity: number;
  unitRate: number;
  amount: number;
  description: string;
};

function toNumberOrNull(value: number | string | null): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Computes the block-hour overage charge for the CURRENT invoicing period,
 * using the cumulative-lifetime rule: the contract's full historical
 * billable-minute total (prior + current) is compared against the
 * lifetime block-hours allotment, and only the portion of the overage that
 * falls within the current period is billed now (avoids re-billing
 * overage minutes already billed on a prior invoice).
 */
export function computeBlockHourCharge(
  contract: ContractBillingInput,
  currentPeriodBillableMinutes: number,
  priorInvoicedBillableMinutes: number,
): BillingChargeResult {
  const hourlyRate = toNumberOrNull(contract.hourlyRate);

  if (contract.blockHours == null || hourlyRate == null) {
    return {
      quantity: 0,
      unitRate: hourlyRate ?? 0,
      amount: 0,
      description: "Block-hour overage",
    };
  }

  const blockMinutes = contract.blockHours * 60;
  const cumulativeTotalMinutes = priorInvoicedBillableMinutes + currentPeriodBillableMinutes;

  const overageMinutes = Math.min(
    currentPeriodBillableMinutes,
    Math.max(0, cumulativeTotalMinutes - blockMinutes),
  );

  const amount = (overageMinutes / 60) * hourlyRate;

  return {
    quantity: overageMinutes / 60,
    unitRate: hourlyRate,
    amount,
    description: "Block-hour overage",
  };
}

/**
 * Flat-fee managed-services charge. Always a single fixed-amount line item
 * regardless of hours logged in the period -- takes no minutes argument.
 */
export function computeFlatFeeCharge(contract: ContractBillingInput): BillingChargeResult {
  const flatFeeAmount = toNumberOrNull(contract.flatFeeAmount) ?? 0;

  return {
    quantity: 1,
    unitRate: flatFeeAmount,
    amount: flatFeeAmount,
    description: "Flat-fee managed services",
  };
}

/**
 * Hourly break-fix charge: every current-period billable minute is billed
 * at the contract's hourly rate. No cumulative/lifetime tracking applies
 * to this billing type.
 */
export function computeHourlyBreakfixCharge(
  contract: ContractBillingInput,
  currentPeriodBillableMinutes: number,
): BillingChargeResult {
  const hourlyRate = toNumberOrNull(contract.hourlyRate) ?? 0;
  const quantity = currentPeriodBillableMinutes / 60;

  return {
    quantity,
    unitRate: hourlyRate,
    amount: quantity * hourlyRate,
    description: "Hourly break-fix",
  };
}

/**
 * Sole entry point Plan 04-05's invoice generation is expected to call.
 * Dispatches on `contract.billingType` to the matching pure charge
 * function, passing only the arguments each billing type needs.
 */
export function computeContractCharges(
  contract: ContractBillingInput,
  currentPeriodBillableMinutes: number,
  priorInvoicedBillableMinutes: number,
): BillingChargeResult {
  switch (contract.billingType) {
    case "block_hour":
      return computeBlockHourCharge(contract, currentPeriodBillableMinutes, priorInvoicedBillableMinutes);
    case "flat_fee":
      return computeFlatFeeCharge(contract);
    case "hourly_breakfix":
      return computeHourlyBreakfixCharge(contract, currentPeriodBillableMinutes);
  }
}
