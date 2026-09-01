import { z } from "zod";

/**
 * Invoice generation validation schema. Per Plan 04-05's locked-in
 * "Required interfaces/content structure": companyId is a required string,
 * periodStart/periodEnd are coerced to Date (the form submits plain
 * yyyy-mm-dd date-input strings), and periodEnd must be on or after
 * periodStart.
 */
export const generateInvoiceSchema = z
  .object({
    companyId: z.string().min(1),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
  })
  .refine((data) => data.periodEnd >= data.periodStart, {
    message: "Period end must be on or after period start",
    path: ["periodEnd"],
  });

export type GenerateInvoiceInput = z.infer<typeof generateInvoiceSchema>;
