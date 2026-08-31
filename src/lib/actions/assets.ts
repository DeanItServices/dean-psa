"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { CRM_MANAGE_ROLES } from "@/lib/permissions";
import { assetSchema } from "@/lib/validations/asset";

/**
 * Creates a new Asset under the given Company, with an optional Site
 * association. Gated to CRM_MANAGE_ROLES (sales, finance, admin) -- see
 * 02-CONTEXT.md's RBAC decisions. An empty siteId (the "no site" option in
 * the form's select) is normalized to null rather than an empty string,
 * since the Asset.siteId column is a nullable foreign key.
 */
export async function createAsset(companyId: string, formData: FormData) {
  await requireRole(CRM_MANAGE_ROLES);

  const parsed = assetSchema.safeParse({
    name: formData.get("name"),
    assetType: formData.get("assetType"),
    serialNumber: formData.get("serialNumber") || undefined,
    notes: formData.get("notes") || undefined,
    siteId: formData.get("siteId") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { siteId, ...rest } = parsed.data;

  await db.asset.create({
    data: {
      ...rest,
      companyId,
      siteId: siteId || null,
    },
  });

  revalidatePath(`/clients/${companyId}`);
  return { success: true };
}

/**
 * Updates an existing Asset's fields in place. Same RBAC gate as
 * createAsset. Catches Prisma's P2025 ("record to update not found") so a
 * concurrently-deleted asset returns a friendly error instead of throwing.
 */
export async function updateAsset(id: string, formData: FormData) {
  await requireRole(CRM_MANAGE_ROLES);

  const parsed = assetSchema.safeParse({
    name: formData.get("name"),
    assetType: formData.get("assetType"),
    serialNumber: formData.get("serialNumber") || undefined,
    notes: formData.get("notes") || undefined,
    siteId: formData.get("siteId") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { siteId, ...rest } = parsed.data;

  try {
    const asset = await db.asset.update({
      where: { id },
      data: {
        ...rest,
        siteId: siteId || null,
      },
    });

    revalidatePath(`/clients/${asset.companyId}`);
    return { success: true };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return { error: "Asset not found" };
    }
    throw error;
  }
}

/**
 * Deletes an Asset. Same RBAC gate as createAsset/updateAsset. Catches
 * Prisma's P2025 so deleting an already-deleted asset returns a friendly
 * error instead of throwing.
 */
export async function deleteAsset(id: string) {
  await requireRole(CRM_MANAGE_ROLES);

  try {
    const asset = await db.asset.delete({
      where: { id },
    });

    revalidatePath(`/clients/${asset.companyId}`);
    return { success: true };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return { error: "Asset not found" };
    }
    throw error;
  }
}
