import { z } from "zod";

export const groupSchema = z
  .object({
    id: z.string(),
    conv_id: z.string(),
    revision: z.number().int().nonnegative(),
    handle: z.string(),
    name: z.string(),
    has_password: z.number().int(),
    type: z.string(),
    members_hidden: z.number().int(),
    admin_only: z.number().int(),
    no_leave: z.number().int(),
    parent_group_id: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();

export type Group = z.infer<typeof groupSchema>;

export const adminGroupSchema = groupSchema
  .extend({
    discoverable: z.number().int(),
    member_count: z.number().int().nonnegative(),
  })
  .strict();
export type AdminGroup = z.infer<typeof adminGroupSchema>;

export const groupMemberSchema = z
  .object({
    id: z.string(),
    created_at: z.string().optional(),
    joined_at: z.string().optional(),
    hide_self: z.number().int().optional(),
  })
  .strict();
export type GroupMember = z.infer<typeof groupMemberSchema>;
