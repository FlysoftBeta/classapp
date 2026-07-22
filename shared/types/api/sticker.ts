import { z } from "zod";

export const stickerPackSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type StickerPackSummary = z.infer<typeof stickerPackSummarySchema>;

export const stickerRecentItemSchema = z
  .object({
    pack: z.string(),
    id: z.string(),
    name: z.string(),
    path: z.string(),
  })
  .strict();
export type StickerRecentItem = z.infer<typeof stickerRecentItemSchema>;
