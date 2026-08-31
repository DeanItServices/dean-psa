import { z } from "zod";

/**
 * Company validation schema. Per 02-CONTEXT.md's locked-in schema decisions,
 * Company has exactly one user-supplied field: name.
 */
export const companySchema = z.object({
  name: z.string().min(1, "Name is required"),
});

export type CompanyInput = z.infer<typeof companySchema>;
