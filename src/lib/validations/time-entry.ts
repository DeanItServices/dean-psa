import { z } from "zod";

/**
 * Time entry update validation schema. Per 04-CONTEXT.md's scope,
 * updateTimeEntry only ever persists isBillable and notes -- startedAt,
 * endedAt, durationMinutes, userId, and contractId are managed exclusively
 * by startTimer/stopTimer, not by this manual-edit path. notes is optional
 * (a technician may clear it or never set it).
 */
export const timeEntryUpdateSchema = z.object({
  isBillable: z.boolean(),
  notes: z.string().optional(),
});

export type TimeEntryUpdateInput = z.infer<typeof timeEntryUpdateSchema>;
