"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { CRM_MANAGE_ROLES } from "@/lib/permissions";
import { contactSchema } from "@/lib/validations/contact";

/**
 * Creates a new Contact under the given Company, optionally associated with
 * one of the company's Sites. Gated to CRM_MANAGE_ROLES (sales, finance,
 * admin) -- see 02-CONTEXT.md's RBAC decisions, sourced from the shared
 * CRM_MANAGE_ROLES constant (not a hardcoded role literal). Follows the same
 * Server Action shape as createSite/createCompany: requireRole() first,
 * then zod safeParse, then the db write, then revalidatePath so the company
 * detail page reflects the new contact without a full navigation.
 */
export async function createContact(companyId: string, formData: FormData) {
  await requireRole(CRM_MANAGE_ROLES);

  const parsed = contactSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email") || "",
    phone: formData.get("phone") || undefined,
    title: formData.get("title") || undefined,
    siteId: formData.get("siteId") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { email, phone, title, siteId, ...rest } = parsed.data;

  await db.contact.create({
    data: {
      ...rest,
      email: email || null,
      phone: phone || null,
      title: title || null,
      siteId: siteId || null,
      companyId,
    },
  });

  revalidatePath(`/clients/${companyId}`);
  return { success: true };
}

/**
 * Updates an existing Contact's fields in place. Same RBAC gate as
 * createContact. If the record no longer exists (Prisma error code P2025),
 * returns a structured error instead of letting the exception propagate
 * unhandled -- see 02-03's edge-case requirements.
 */
export async function updateContact(id: string, formData: FormData) {
  await requireRole(CRM_MANAGE_ROLES);

  const parsed = contactSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email") || "",
    phone: formData.get("phone") || undefined,
    title: formData.get("title") || undefined,
    siteId: formData.get("siteId") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { email, phone, title, siteId, ...rest } = parsed.data;

  try {
    const contact = await db.contact.update({
      where: { id },
      data: {
        ...rest,
        email: email || null,
        phone: phone || null,
        title: title || null,
        siteId: siteId || null,
      },
    });

    revalidatePath(`/clients/${contact.companyId}`);
    return { success: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Contact not found" };
    }
    throw err;
  }
}

/**
 * Deletes a Contact. Same RBAC gate as createContact/updateContact. Catches
 * Prisma's P2025 (record not found -- e.g. a double-click or stale UI state
 * racing another delete) and returns a structured error rather than
 * throwing an unhandled exception.
 */
export async function deleteContact(id: string) {
  await requireRole(CRM_MANAGE_ROLES);

  try {
    const contact = await db.contact.delete({
      where: { id },
    });

    revalidatePath(`/clients/${contact.companyId}`);
    return { success: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Contact not found" };
    }
    throw err;
  }
}
