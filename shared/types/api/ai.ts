import { z } from "zod";

export const aiMessageStatusSchema = z.enum([
  "pending",
  "streaming",
  "completed",
  "failed",
  "cancelled",
]);

export const aiAttachmentSchema = z
  .object({
    path: z.string(),
    name: z.string(),
    mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    size: z.number().int().positive(),
  })
  .strict();

export const aiMessageSchema = z
  .object({
    id: z.string().uuid(),
    conversation_id: z.string().uuid(),
    parent_message_id: z.string().uuid().nullable(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    attachments: z.array(aiAttachmentSchema),
    status: aiMessageStatusSchema,
    sequence: z.number().int().positive(),
    run_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export const aiConversationSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    last_message: z.string().nullable(),
    active_leaf_message_id: z.string().uuid().nullable(),
    forked_from_conversation_id: z.string().uuid().nullable(),
    forked_from_message_id: z.string().uuid().nullable(),
    unread: z.boolean(),
    running: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export const aiRunStatusSchema = z.enum([
  "queued",
  "routing",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const aiRunSchema = z
  .object({
    id: z.string().uuid(),
    conversation_id: z.string().uuid(),
    input_message_id: z.string().uuid(),
    output_message_id: z.string().uuid(),
    status: aiRunStatusSchema,
    revision: z.number().int().nonnegative(),
    error: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export const aiConversationDetailSchema = z
  .object({
    conversation: aiConversationSchema,
    messages: z.array(aiMessageSchema),
    active_run: aiRunSchema.nullable(),
  })
  .strict();

export const aiCreditBalanceSchema = z
  .object({
    balance: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
  })
  .strict();

export const aiCreditLedgerEntrySchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string(),
    kind: z.enum(["top_up", "reserve", "settle", "release"]),
    delta: z.number().int(),
    balance_after: z.number().int().nonnegative(),
    run_id: z.string().uuid().nullable(),
    admin_id: z.string().nullable(),
    note: z.string(),
    created_at: z.string(),
  })
  .strict();

export const aiFileEntrySchema = z
  .object({
    path: z.string(),
    mime: z.string(),
    size: z.number().int().nonnegative(),
    updated_at: z.string(),
  })
  .strict();

export type AiMessage = z.infer<typeof aiMessageSchema>;
export type AiAttachment = z.infer<typeof aiAttachmentSchema>;
export type AiConversation = z.infer<typeof aiConversationSchema>;
export type AiRun = z.infer<typeof aiRunSchema>;
export type AiConversationDetail = z.infer<typeof aiConversationDetailSchema>;
export type AiCreditBalance = z.infer<typeof aiCreditBalanceSchema>;
export type AiCreditLedgerEntry = z.infer<typeof aiCreditLedgerEntrySchema>;
export type AiFileEntry = z.infer<typeof aiFileEntrySchema>;
