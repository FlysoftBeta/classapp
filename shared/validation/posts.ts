import { z } from "zod";

/** 客户端发帖 payload 类型与校验（无 Node 依赖） */

/** 列表展开与文章转换共用的长文本阈值（字符数） */
export const LONG_TEXT_THRESHOLD = 500;

export const POST_PREVIEW_LENGTH = 1000;

export const createTextPostPayloadSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1),
  })
  .strict();
export const createStickerPostPayloadSchema = z
  .object({
    type: z.literal("sticker"),
    sticker_pack: z.string().min(1),
    sticker_id: z.string().min(1),
  })
  .strict();

export const createPostPayloadSchema = z.discriminatedUnion("type", [
  createTextPostPayloadSchema,
  createStickerPostPayloadSchema,
]);

export type CreatePostPayload = z.infer<typeof createPostPayloadSchema>;

export function isCreatePostPayload(
  value: unknown,
): value is CreatePostPayload {
  return createPostPayloadSchema.safeParse(value).success;
}
