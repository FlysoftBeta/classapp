import { z } from "zod";

export const userSchema = z
  .object({
    id: z.string(),
    handle: z.string(),
    username: z.string(),
    feature_mask: z.number().int(),
    is_muted: z.number().int(),
    muted_until: z.string().nullable(),
    banned_until: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();

export type User = z.infer<typeof userSchema>;
