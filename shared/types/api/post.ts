import { z } from "zod";

const postCommonShape = {
  id: z.string(),
  /** Stable server ordering key within the post stream. */
  sequence: z.number().int().optional(),
  user_id: z.string().nullable(),
  /** 摘要：列表预览、搜索；短文本即正文 */
  brief: z.string(),
  group_id: z.string().nullable(),
  dm_to: z.string().nullable(),
  reply_to: z.string().nullable(),
  is_deleted: z.number().int(),
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

export const postSchema = z.discriminatedUnion("type", [
  textPostSchema,
  stickerPostSchema,
]);
export type Post = z.infer<typeof postSchema>;

export function isTextPost(post: Post): post is TextPost {
  return post.type === "text";
}

export function isStickerPost(post: Post): post is StickerPost {
  return post.type === "sticker";
}

export function postPreview(post: Post): string {
  return post.type === "text" ? post.text : post.brief;
}
