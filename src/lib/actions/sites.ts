"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { CRM_MANAGE_ROLES } from "@/lib/permissions";
import { siteSchema } from "@/lib/validations/site";

/**
 * Creates a new Site under the given Company. Gated to CRM_MANAGE_ROLES
 * (sales, finance, admin) -- see 02-CONTEXT.md's RBAC decisions.
 * Revalidates the company detail page so the new site appears without a
 * full navigation.
 */
export async function createSite(companyId: string, formData: FormData) {
  await requireRole(CRM_MANAGE_ROLES);

  const parsed = siteSchema.safeParse({
    addressLine1: formData.get("addressLine1"),
    addressLine2: formData.get("addressLine2") || undefined,
    city: formData.get("city"),
    state: formData.get("state"),
    postalCode: formData.get("postalCode"),
    country: formData.get("country"),
    isPrimary: formData.get("isPrimary") === "on",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await db.site.create({
    data: {
      ...parsed.data,
      companyId,
    },
  });

  revalidatePath(`/clients/${companyId}`);
  return { success: true };
}

/**
 * Updates an existing Site's fields in place. Same RBAC gate as
 * createSite. Catches Prisma's P2025 (record not found) and returns a
 * friendly error instead of letting the exception propagate unhandled.
 */
export async function updateSite(id: string, formData: FormData) {
  await requireRole(CRM_MANAGE_ROLES);

  const parsed = siteSchema.safeParse({
    addressLine1: formData.get("addressLine1"),
    addressLine2: formData.get("addressLine2") || undefined,
    city: formData.get("city"),
    state: formData.get("state"),
    postalCode: formData.get("postalCode"),
    country: formData.get("country"),
    isPrimary: formData.get("isPrimary") === "on",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const site = await db.site.update({
      where: { id },
      data: parsed.data,
    });

    revalidatePath(`/clients/${site.companyId}`);
    return { success: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Site not found" };
    }
    throw err;
  }
}

/**
 * Deletes a Site. Same RBAC gate as createSite/updateSite. Catches
 * Prisma's P2025 (record not found) and returns a friendly error instead
 * of letting the exception propagate unhandled.
 */
export async function deleteSite(id: string) {
  await requireRole(CRM_MANAGE_ROLES);

  try {
    const site = await db.site.delete({
      where: { id },
    });

    revalidatePath(`/clients/${site.companyId}`);
    return { success: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Site not found" };
    }
    throw err;
  }
}
