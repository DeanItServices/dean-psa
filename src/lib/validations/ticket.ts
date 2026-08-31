import { z } from "zod";

/**
 * Ticket create/update validation schema. Per 03-CONTEXT.md's locked-in
 * schema decisions and the Ticket model in prisma/schema.prisma: companyId
 * is required, contactId/assetId/assignedToId/contractId are optional
 * relations (the UI passes the "none" sentinel for "not set", which is
 * stripped to undefined before this schema sees it -- see
 * src/components/crm/contact-form.tsx's established pattern), status and
 * priority are the Ticket model's enums, and subject/description are
 * required non-empty strings.
 */
export const ticketSchema = z.object({
  companyId: z.string().min(1, "Company is required"),
  contactId: z.string().optional(),
  assetId: z.string().optional(),
  assignedToId: z.string().optional(),
  contractId: z.string().optional(),
  status: z.enum(["new", "in_progress", "waiting_on_client", "resolved", "closed"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  subject: z.string().min(1, "Subject is required"),
  description: z.string().min(1, "Description is required"),
});

export type TicketInput = z.infer<typeof ticketSchema>;

/**
 * Update schema is narrowed to exactly the fields updateTicket persists
 * (companyId, contactId, assetId, priority, subject, description).
 * assignedToId, contractId, and status are intentionally omitted here --
 * updateTicket does not change them (those are separate Server Actions:
 * updateTicketStatus, assignTicket), and validating fields the action never
 * writes would create drift between "what's validated" and "what's
 * persisted" for any future caller of this schema.
 */
export const ticketUpdateSchema = ticketSchema.omit({
  assignedToId: true,
  contractId: true,
  status: true,
});
export type TicketUpdateInput = z.infer<typeof ticketUpdateSchema>;
