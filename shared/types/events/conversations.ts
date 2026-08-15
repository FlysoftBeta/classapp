import { z } from "zod";
import { conversationEntitySchema } from "../api/conversation";
import { postSchema, type PostEntity } from "../api/post";
import { userMetadataSchema } from "../api/user";
import type { UserMetadata } from "../api/user";

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
    entry: conversationEntitySchema.optional(),
    users: z.array(userMetadataSchema).optional(),
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
    users: z.array(userMetadataSchema),
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
      data?: { post: PostEntity; users: UserMetadata[] };
    }
  | {
      kind: "post.deleted";
      data?: { post: PostEntity; users: UserMetadata[] };
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
