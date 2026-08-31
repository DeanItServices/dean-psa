"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { CRM_MANAGE_ROLES } from "@/lib/permissions";
import { contractSchema, type ContractInput } from "@/lib/validations/contract";

/**
 * Prisma "record not found" error code, thrown by update()/delete() when the
 * where clause matches no row. Caught explicitly below so a
 * concurrently-deleted contract returns a friendly { error } instead of an
 * unhandled 500.
 */
const PRISMA_NOT_FOUND = "P2025";

function isPrismaNotFound(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === PRISMA_NOT_FOUND
  );
}

/**
 * Parses raw FormData into the plain object shape contractSchema expects.
 * Only the billing-type-specific field relevant to the submitted
 * billingType is read from the form -- coercion of numeric/date strings is
 * left to zod's z.coerce (see contract.ts), so empty-string optional fields
 * are passed through as undefined rather than "" (which z.coerce.number()
 * would otherwise reject).
 */
function parseContractFormData(formData: FormData): Record<string, unknown> {
  const billingType = formData.get("billingType");

  const raw: Record<string, unknown> = {
    billingType,
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate") || undefined,
    slaResponseMinutes: formData.get("slaResponseMinutes") || undefined,
    slaResolutionMinutes: formData.get("slaResolutionMinutes") || undefined,
  };

  if (billingType === "block_hour") {
    raw.blockHours = formData.get("blockHours");
  } else if (billingType === "flat_fee") {
    raw.flatFeeAmount = formData.get("flatFeeAmount");
  } else if (billingType === "hourly_breakfix") {
    raw.hourlyRate = formData.get("hourlyRate");
  }

  return raw;
}

/**
 * Maps a validated ContractInput (one discriminated-union branch) to the
 * exact set of Prisma columns to write. Only the billing-type-specific
 * column relevant to the parsed branch is set -- the other two billing-type
 * columns are left null/undefined (matching 02-CONTEXT.md's Contract schema
 * decision: nullable typed columns, only one populated per contract).
 */
function toContractData(data: ContractInput) {
  const base = {
    billingType: data.billingType,
    startDate: data.startDate,
    endDate: data.endDate ?? null,
    slaResponseMinutes: data.slaResponseMinutes ?? null,
    slaResolutionMinutes: data.slaResolutionMinutes ?? null,
    blockHours: null as number | null,
    flatFeeAmount: null as number | null,
    hourlyRate: null as number | null,
  };

  if (data.billingType === "block_hour") {
    base.blockHours = data.blockHours;
  } else if (data.billingType === "flat_fee") {
    base.flatFeeAmount = data.flatFeeAmount;
  } else if (data.billingType === "hourly_breakfix") {
    base.hourlyRate = data.hourlyRate;
  }

  return base;
}

/**
 * Creates a new Contract under the given Company. Gated to
 * CRM_MANAGE_ROLES (sales, finance, admin) -- see 02-CONTEXT.md's RBAC
 * decisions. requireRole() is the authoritative server-side check and runs
 * before any database write, independent of whether the calling page
 * already gated access.
 */
export async function createContract(companyId: string, formData: FormData) {
  await requireRole(CRM_MANAGE_ROLES);

  const parsed = contractSchema.safeParse(parseContractFormData(formData));

  if (!parsed.success) {
    return { error: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }

  await db.contract.create({
    data: {
      ...toContractData(parsed.data),
      companyId,
    },
  });

  revalidatePath(`/clients/${companyId}`);
  return { success: true };
}

/**
 * Updates an existing Contract's fields in place. Same RBAC gate as
 * createContract. Catches P2025 (record not found, e.g. concurrently
 * deleted) and returns a friendly error instead of throwing.
 */
export async function updateContract(id: string, formData: FormData) {
  await requireRole(CRM_MANAGE_ROLES);

  const parsed = contractSchema.safeParse(parseContractFormData(formData));

  if (!parsed.success) {
    return { error: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }

  try {
    const contract = await db.contract.update({
      where: { id },
      data: toContractData(parsed.data),
    });

    revalidatePath(`/clients/${contract.companyId}`);
    return { success: true };
  } catch (err) {
    if (isPrismaNotFound(err)) {
      return { error: "Contract not found" };
    }
    throw err;
  }
}

/**
 * Deletes a Contract. Same RBAC gate as createContract/updateContract.
 * Catches P2025 (record not found) and returns a friendly error instead of
 * an unhandled exception.
 */
export async function deleteContract(id: string) {
  await requireRole(CRM_MANAGE_ROLES);

  try {
    const contract = await db.contract.delete({
      where: { id },
    });

    revalidatePath(`/clients/${contract.companyId}`);
    return { success: true };
  } catch (err) {
    if (isPrismaNotFound(err)) {
      return { error: "Contract not found" };
    }
    throw err;
  }
}
