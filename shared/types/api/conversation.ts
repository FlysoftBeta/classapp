import { z } from "zod";

export const conversationSchema = z
  .object({
    /** Canonical storage/synchronization identity (`group:*` or `dm:*`). */
    conv_id: z.string(),
    /** Monotonic awareness revision for post appends/edits/tombstones. */
    revision: z.number().int().nonnegative(),
    type: z.enum(["group", "dm"]),
    /** Group id (UUID) or peer user id. */
    id: z.string(),
    /** Group handle (for groups) or DM peer handle (for DMs). */
    handle: z.string().nullable(),
    /** Display name. */
    name: z.string(),
    has_password: z.number().int(),
    /** Group flags — present on group rows only, kept on DM rows as 0. */
    members_hidden: z.number().int(),
    admin_only: z.number().int(),
    no_leave: z.number().int(),
    /** Server-evaluated actor capabilities. The client must not reimplement policy. */
    can_post: z.boolean(),
    can_leave: z.boolean(),
    last_message: z.string().nullable(),
    last_at: z.string().nullable(),
    last_read_post_id: z.string().nullable(),
    /** Stable server ordering key for last_read_post_id; 0 means unread. */
    last_read_post_sequence: z.number().int(),
    /** Mutation timestamp retained for acknowledgement/audit, not read ordering. */
    read_updated_at_ms: z.number(),
    first_unread_post_id: z.string().nullable(),
    unread_count: z.number().int(),
    pinned: z.number().int(),
    pinned_updated_at_ms: z.number(),
    muted: z.number().int(),
    muted_updated_at_ms: z.number(),
  })
  .strict();

export type Conversation = z.infer<typeof conversationSchema>;
