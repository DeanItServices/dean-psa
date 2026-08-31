import { z } from "zod";

/**
 * Site validation schema, matching the Site model's address fields defined
 * in prisma/schema.prisma (02-01). addressLine2 is optional; every other
 * address field is required. isPrimary defaults to false -- duplicate
 * isPrimary: true values on the same company are allowed at the schema
 * level (out of scope for this validator, per 02-CONTEXT.md).
 */
export const siteSchema = z.object({
  addressLine1: z.string().min(1, "Address line 1 is required"),
  addressLine2: z.string().optional(),
  city: z.string().min(1, "City is required"),
  state: z.string().min(1, "State is required"),
  postalCode: z.string().min(1, "Postal code is required"),
  country: z.string().min(1, "Country is required"),
  isPrimary: z.boolean().default(false),
});

export type SiteInput = z.infer<typeof siteSchema>;
