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

export const postImageThumbStateSchema = z.enum([
  "absent",
  "staging",
  "ready",
  "failed",
]);
export type PostImageThumbState = z.infer<typeof postImageThumbStateSchema>;

export const postImageThumbSchema = z
  .object({
    state: postImageThumbStateSchema,
    mime: z.string().nullable(),
    bytes: z.number().int().nonnegative(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    sha256: z.string().nullable(),
  })
  .strict();
export type PostImageThumb = z.infer<typeof postImageThumbSchema>;

export const imagePostSchema = z
  .object({
    ...postCommonShape,
    type: z.literal("image"),
    image_id: z.string(),
    mime: z.string(),
    bytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sha256: z.string(),
    thumb: postImageThumbSchema,
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
  imagePostSchema,
  deletedPostSchema,
]);
export type PostEntity = z.infer<typeof postSchema>;
export type TextPostEntity = Extract<PostEntity, { type: "text" }>;
export type StickerPostEntity = Extract<PostEntity, { type: "sticker" }>;
export type ImagePostEntity = Extract<PostEntity, { type: "image" }>;

export function isTextPost(post: PostEntity): post is TextPostEntity {
  return post.type === "text";
}

export function isStickerPost(post: PostEntity): post is StickerPostEntity {
  return post.type === "sticker";
}

export function isImagePost(post: PostEntity): post is ImagePostEntity {
  return post.type === "image";
}

export function postPreview(post: PostEntity): string {
  if (post.type === "deleted") return "消息已删除";
  if (post.type === "text") return post.text;
  return post.brief;
}
