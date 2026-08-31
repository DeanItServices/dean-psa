"use server";

import { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { CRM_MANAGE_ROLES } from "@/lib/permissions";
import { companySchema } from "@/lib/validations/company";

/**
 * Creates a new Company. Gated to CRM_MANAGE_ROLES (sales, finance, admin)
 * -- see 02-CONTEXT.md's RBAC decisions. requireRole() is the authoritative
 * server-side check and runs before any database write, independent of
 * whether the calling page already gated access (Server Actions are
 * directly callable).
 */
export async function createCompany(formData: FormData) {
  await requireRole(CRM_MANAGE_ROLES);

  const parsed = companySchema.safeParse({
    name: formData.get("name"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const company = await db.company.create({
    data: parsed.data,
  });

  redirect(`/clients/${company.id}`);
}

/**
 * Updates an existing Company's fields in place. Same RBAC gate as
 * createCompany. Returns { success: true } rather than redirecting, since
 * this is used for in-place edits on the detail page. Catches Prisma's
 * P2025 (record not found) and returns a friendly error instead of letting
 * the exception propagate unhandled.
 */
export async function updateCompany(id: string, formData: FormData) {
  await requireRole(CRM_MANAGE_ROLES);

  const parsed = companySchema.safeParse({
    name: formData.get("name"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await db.company.update({
      where: { id },
      data: parsed.data,
    });

    return { success: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Company not found" };
    }
    throw err;
  }
}

/**
 * Deletes a Company. Same RBAC gate as createCompany/updateCompany.
 * WARNING: deleting a Company cascades (onDelete: Cascade in
 * prisma/schema.prisma) to ALL of its Sites, Contacts, Contracts, and
 * Assets -- any UI that wires this up MUST add an explicit confirmation
 * step before calling it.
 */
export async function deleteCompany(id: string) {
  await requireRole(CRM_MANAGE_ROLES);

  try {
    await db.company.delete({
      where: { id },
    });

    revalidatePath(`/clients`);
    return { success: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Company not found" };
    }
    throw err;
  }
}
