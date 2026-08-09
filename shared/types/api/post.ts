import { z } from "zod";

const postCommonShape = {
  id: z.string(),
  /** Stable server ordering key within the post stream. */
  sequence: z.number().int().positive(),
  user_id: z.string().nullable(),
  /** Canonical conversation identity; the only post target field. */
  conv_id: z.string(),
  /** Conversation revision at which this current row version was written. */
  revision: z.number().int().nonnegative(),
  /** 摘要：列表预览、搜索；短文本即正文 */
  brief: z.string(),
  reply_to: z.string().nullable(),
  deleted_at: z.string().nullable(),
  edited_at: z.string().nullable(),
  created_at: z.string(),
  username: z.string().nullable().optional(),
  handle: z.string().nullable().optional(),
  group_name: z.string().nullable().optional(),
  reply_username: z.string().nullable().optional(),
  reply_handle: z.string().nullable().optional(),
  reply_brief: z.string().nullable().optional(),
  is_truncated: z.boolean().optional(),
};

export const textPostSchema = z
  .object({
    ...postCommonShape,
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();
export type TextPost = z.infer<typeof textPostSchema>;

export const stickerPostSchema = z
  .object({
    ...postCommonShape,
    type: z.literal("sticker"),
    sticker_pack: z.string(),
    sticker_id: z.string(),
    path: z.string(),
    name: z.string(),
  })
  .strict();
export type StickerPost = z.infer<typeof stickerPostSchema>;

export const deletedPostSchema = z
  .object({
    ...postCommonShape,
    type: z.literal("deleted"),
  })
  .strict();
export type DeletedPost = z.infer<typeof deletedPostSchema>;

export const postSchema = z.discriminatedUnion("type", [
  textPostSchema,
  stickerPostSchema,
  deletedPostSchema,
]);
export type Post = z.infer<typeof postSchema>;

export function isTextPost(post: Post): post is TextPost {
  return post.type === "text";
}

export function isStickerPost(post: Post): post is StickerPost {
  return post.type === "sticker";
}

export function postPreview(post: Post): string {
  if (post.type === "deleted") return "消息已删除";
  return post.type === "text" ? post.text : post.brief;
}
