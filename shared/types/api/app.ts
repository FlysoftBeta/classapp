import { z } from "zod";

export const appDisableReasonSchema = z.enum([
  "banned",
  "system_locked",
  "idle",
]);
export type AppDisableReason = z.infer<typeof appDisableReasonSchema>;

export const appDisableStateSchema = z
  .object({
    disabled: z.boolean(),
    reason: appDisableReasonSchema.nullable(),
    banned_until: z.string().nullable().optional(),
    username: z.string().nullable().optional(),
  })
  .strict();

export type AppDisableState = z.infer<typeof appDisableStateSchema>;
