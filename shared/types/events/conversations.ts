import { z } from "zod";
import { conversationSchema } from "../api/conversation";
import { postSchema } from "../api/post";

export const convEventSpecSchema = z.union([
  z.object({ type: z.enum(["group", "dm"]), id: z.string() }).strict(),
  z
    .object({
      type: z.enum(["group", "dm"]),
      id: z.string(),
      removed: z.literal(true),
    })
    .strict(),
]);
export type ConvEventSpec = z.infer<typeof convEventSpecSchema>;

export const convUpdatedPayloadSchema = z
  .object({
    entry: conversationSchema.optional(),
    removed: z
      .object({
        type: z.enum(["group", "dm"]),
        id: z.string(),
      })
      .strict()
      .optional(),
    /** Fallback when the delta cannot be computed. */
    refresh: z.literal(true).optional(),
  })
  .strict();
export type ConvUpdatedPayload = z.infer<typeof convUpdatedPayloadSchema>;

export const postChangedPayloadSchema = z
  .object({
    post: postSchema,
  })
  .strict();
/**
 * Deletion is a normal post version. Carry the authoritative tombstone so a
 * live client stores the same revision as a client that later performs a
 * revision-based catch-up.
 */
export const postDeletedPayloadSchema = postChangedPayloadSchema;

export type PostStreamEvent =
  | {
      kind: "post.created" | "post.updated";
      data?: z.infer<typeof postChangedPayloadSchema>;
    }
  | {
      kind: "post.deleted";
      data?: z.infer<typeof postDeletedPayloadSchema>;
    };

export const userConfigChangedEventSchema = z
  .object({
    key: z.string(),
    value: z.string().nullable(),
    updatedAt: z.number().optional(),
  })
  .strict();
export type UserConfigChangedEvent = z.infer<
  typeof userConfigChangedEventSchema
>;
