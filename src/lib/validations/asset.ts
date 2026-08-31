import { z } from "zod";

/**
 * Asset validation schema. Per 02-CONTEXT.md, assetType is free text (no
 * enum/fixed dropdown) and siteId is optional (an asset may be scoped to a
 * company without a specific site).
 */
export const assetSchema = z.object({
  name: z.string().min(1, "Name is required"),
  assetType: z.string().min(1, "Asset type is required"),
  serialNumber: z.string().optional(),
  notes: z.string().optional(),
  siteId: z.string().optional(),
});

export type AssetInput = z.infer<typeof assetSchema>;
