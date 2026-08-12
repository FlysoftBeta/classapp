import { z } from "zod";
import {
  aiConversationSchema,
  aiMessageSchema,
  aiRunSchema,
} from "@/shared/types/api/ai";

export const aiRunUpdatedPayloadSchema = z
  .object({
    run: aiRunSchema,
    conversation: aiConversationSchema,
    message: aiMessageSchema,
  })
  .strict();

export const aiSidebarUpdatedPayloadSchema = z
  .object({ refresh: z.literal(true) })
  .strict();

export type AiRunUpdatedPayload = z.infer<typeof aiRunUpdatedPayloadSchema>;
export type AiSidebarUpdatedPayload = z.infer<
  typeof aiSidebarUpdatedPayloadSchema
>;
