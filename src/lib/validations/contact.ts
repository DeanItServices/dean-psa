import { z } from "zod";

/**
 * Contact validation schema. Per 02-CONTEXT.md's locked-in schema decisions
 * and the Contact model in prisma/schema.prisma: name is required, email
 * (if provided) must be a valid address or an empty string (so an
 * intentionally-cleared field doesn't fail validation), phone/title are
 * free-text optional strings, and siteId is an optional association to one
 * of the company's sites.
 */
export const contactSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address").optional().or(z.literal("")),
  phone: z.string().optional(),
  title: z.string().optional(),
  siteId: z.string().optional(),
});

export type ContactInput = z.infer<typeof contactSchema>;
