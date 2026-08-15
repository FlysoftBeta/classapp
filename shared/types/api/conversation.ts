import { z } from "zod";

const conversationCommonShape = {
  conv_id: z.string(),
  revision: z.number().int().nonnegative(),
  /** Group id (UUID) or peer user id. */
  id: z.string(),
  has_password: z.number().int(),
  members_hidden: z.number().int(),
  admin_only: z.number().int(),
  no_leave: z.number().int(),
  can_post: z.boolean(),
  can_leave: z.boolean(),
  last_message: z.string().nullable(),
  last_at: z.string().nullable(),
  last_read_post_id: z.string().nullable(),
  last_read_post_sequence: z.number().int(),
  read_updated_at_ms: z.number(),
  first_unread_post_id: z.string().nullable(),
  unread_count: z.number().int(),
  pinned: z.number().int(),
  pinned_updated_at_ms: z.number(),
  muted: z.number().int(),
  muted_updated_at_ms: z.number(),
};

export const groupConversationSchema = z
  .object({
    ...conversationCommonShape,
    type: z.literal("group"),
    group_type: z.string(),
    /** Group-owned labels belong to the Group objective entity. */
    handle: z.string(),
    name: z.string(),
  })
  .strict();

export const dmConversationSchema = z
  .object({
    ...conversationCommonShape,
    type: z.literal("dm"),
    group_type: z.null(),
  })
  .strict();

/** Wire entity. DM peer presentation is carried only in the users side bundle. */
export const conversationEntitySchema = z.discriminatedUnion("type", [
  groupConversationSchema,
  dmConversationSchema,
]);
export type ConversationEntity = z.infer<typeof conversationEntitySchema>;
