"use server";

import { redirect } from "next/navigation";
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
 * this is used for in-place edits on the detail page.
 */
export async function updateCompany(id: string, formData: FormData) {
  await requireRole(CRM_MANAGE_ROLES);

  const parsed = companySchema.safeParse({
    name: formData.get("name"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await db.company.update({
    where: { id },
    data: parsed.data,
  });

  return { success: true };
}
