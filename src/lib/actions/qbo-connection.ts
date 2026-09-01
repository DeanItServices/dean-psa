"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { QBO_MANAGE_ROLES } from "@/lib/permissions";

/**
 * Disconnects the QuickBooks Online integration by deleting the single
 * QuickBooksConnection row (if any). Gated to QBO_MANAGE_ROLES (admin) --
 * see 04-CONTEXT.md's RBAC decisions. Uses deleteMany rather than delete
 * since there may be zero rows (idempotent: calling this when already
 * disconnected is not an error).
 */
export async function disconnectQbo() {
  await requireRole(QBO_MANAGE_ROLES);

  await db.quickBooksConnection.deleteMany({});

  revalidatePath("/admin/quickbooks");

  return { success: true };
}

/**
 * Sets (or clears, when qboCustomerId is null) a Company's manually-entered
 * QuickBooks Customer id. This is a human-entered plain text field only --
 * no QBO Customer search/create/auto-match is performed here or anywhere in
 * this plan's scope; Plan 04-06's invoice push logic is expected to read
 * this field to know which QBO Customer an invoice belongs to.
 */
export async function setCompanyQboCustomerId(companyId: string, qboCustomerId: string | null) {
  await requireRole(QBO_MANAGE_ROLES);

  const normalized = qboCustomerId?.trim() || null;

  try {
    await db.company.update({
      where: { id: companyId },
      data: { qboCustomerId: normalized },
    });

    revalidatePath("/admin/quickbooks");
    return { success: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "Company not found" };
    }
    throw err;
  }
}
