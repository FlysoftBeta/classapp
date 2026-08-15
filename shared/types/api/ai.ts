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
    available: z.number().nonnegative(),
    reserved: z.number().nonnegative(),
    top_up: z.number().nonnegative(),
    plan: z
      .object({
        active: z.boolean(),
        starts_at: z.string().nullable(),
        ends_at: z.string().nullable(),
        daily: z
          .object({
            allowance: z.number().nonnegative(),
            used: z.number().nonnegative(),
            remaining: z.number().nonnegative(),
            used_percent: z.number().min(0).max(100),
          })
          .strict(),
        weekly: z
          .object({
            allowance: z.number().nonnegative(),
            used: z.number().nonnegative(),
            remaining: z.number().nonnegative(),
            used_percent: z.number().min(0).max(100),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const aiCreditLedgerEntrySchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string(),
    kind: z.enum(["top_up", "reserve", "settle", "release"]),
    delta: z.number(),
    top_up_after: z.number().nonnegative(),
    run_id: z.string().uuid().nullable(),
    admin_id: z.string().nullable(),
    note: z.string(),
    created_at: z.string(),
  })
  .strict();

export const aiBillingPolicySchema = z
  .object({
    daily_allowance: z.number().nonnegative(),
    weekly_allowance: z.number().nonnegative(),
    default_plan_duration_days: z.number().int().positive(),
    updated_at: z.string(),
  })
  .strict();

export const aiBillingSummarySchema = z
  .object({
    policy: aiBillingPolicySchema,
    stock: z
      .object({
        weekly_plan: z.number().nonnegative(),
        top_up: z.number().nonnegative(),
        total: z.number().nonnegative(),
      })
      .strict(),
    consumption_by_day: z.array(
      z
        .object({ date: z.string(), credits: z.number().nonnegative() })
        .strict(),
    ),
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
export type AiBillingPolicy = z.infer<typeof aiBillingPolicySchema>;
export type AiBillingSummary = z.infer<typeof aiBillingSummarySchema>;
export type AiFileEntry = z.infer<typeof aiFileEntrySchema>;
