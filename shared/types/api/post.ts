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
  reply_user_id: z.string().nullable(),
  deleted_at: z.string().nullable(),
  edited_at: z.string().nullable(),
  created_at: z.string(),
  reply_brief: z.string().nullable(),
  is_truncated: z.boolean().optional(),
};

export const textPostSchema = z
  .object({
    ...postCommonShape,
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

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

export const deletedPostSchema = z
  .object({
    ...postCommonShape,
    type: z.literal("deleted"),
  })
  .strict();

export const postSchema = z.discriminatedUnion("type", [
  textPostSchema,
  stickerPostSchema,
  deletedPostSchema,
]);
export type PostEntity = z.infer<typeof postSchema>;

/** Client presentation assembled from PostEntity + domain_users. */
export type Post = PostEntity & {
  username?: string | null;
  handle?: string | null;
  reply_username?: string | null;
  reply_handle?: string | null;
};

export type TextPost = Extract<Post, { type: "text" }>;
export type StickerPost = Extract<Post, { type: "sticker" }>;
export type DeletedPost = Extract<Post, { type: "deleted" }>;

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
