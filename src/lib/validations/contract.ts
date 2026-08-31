import { z } from "zod";

/**
 * Contract validation schema, keyed on billingType via z.discriminatedUnion
 * (prisma/schema.prisma's BillingType enum: block_hour | flat_fee |
 * hourly_breakfix -- see 02-01/02-CONTEXT.md). Each branch requires exactly
 * its own type-specific amount/rate field -- the discriminated union is
 * what enforces "the correct fields for that type only": a block_hour
 * payload cannot satisfy the flat_fee or hourly_breakfix branches (and vice
 * versa) because zod tries only the branch matching the literal billingType
 * value and the type-specific field is required (not optional) on that
 * branch alone.
 *
 * SLA response/resolution targets and start/end dates are shared across all
 * three billing types (per 02-CONTEXT.md's Contract schema decision) and
 * both SLA fields are optional -- a contract with no SLA fields set must be
 * allowed (see plan's edge cases).
 *
 * endDate < startDate is NOT validated here -- explicitly out of scope for
 * this plan per the execution contract's edge cases; accepted gap.
 */
const baseFields = {
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional(),
  slaResponseMinutes: z.coerce.number().int().positive().optional(),
  slaResolutionMinutes: z.coerce.number().int().positive().optional(),
};

export const contractSchema = z.discriminatedUnion("billingType", [
  z.object({
    billingType: z.literal("block_hour"),
    blockHours: z.coerce.number().int().positive(),
    ...baseFields,
  }),
  z.object({
    billingType: z.literal("flat_fee"),
    flatFeeAmount: z.coerce.number().positive(),
    ...baseFields,
  }),
  z.object({
    billingType: z.literal("hourly_breakfix"),
    hourlyRate: z.coerce.number().positive(),
    ...baseFields,
  }),
]);

export type ContractInput = z.infer<typeof contractSchema>;
