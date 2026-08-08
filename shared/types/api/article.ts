import { z } from "zod";
import { TEXT_ARTICLE_SEGMENT_SIZE } from "@/shared/articles/segments";

const articleBaseShape = {
  id: z.string(),
  user_id: z.string().nullable(),
  /** Group conversation that owns this article. */
  group_id: z.string(),
  title: z.string(),
  provider: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("text"),
      words: z.number().int().nonnegative(),
      chunks: z.number().int().nonnegative(),
    }),
    z.object({
      type: z.literal("blob"),
      file_name: z.string(),
      mime_type: z.string().nullable().optional(),
      bytes: z.number().int().nonnegative().optional(),
      original_name: z.string().nullable().optional(),
    }),
  ]),
  content_kind: z.enum(["text", "blob"]),
  blob_path: z.string().nullable().optional(),
  mime_type: z.string().nullable().optional(),
  file_size: z.number().nonnegative(),
  original_filename: z.string().nullable().optional(),
  created_at: z.string(),
  username: z.string().nullable().optional(),
  handle: z.string().nullable().optional(),
};

export const articleWithMetaSchema = z
  .object({
    ...articleBaseShape,
    content: z.string().optional(),
    is_bookmarked: z.boolean(),
    bookmark_updated_at_ms: z.number(),
    current_offset: z.number().int().nonnegative(),
    /** Logical modification time used to arbitrate reading-position conflicts. */
    current_offset_updated_at: z.number(),
    current_locator: z.string().nullable().optional(),
    content_length: z.number().int().nonnegative(),
    total_read_seconds: z.number().optional(),
    last_read_at: z.string().nullable().optional(),
    /** Opaque server ordering value for cursor pagination. */
    list_sort_at: z.string().optional(),
  })
  .strict();
export type ArticleWithMeta = z.infer<typeof articleWithMetaSchema>;

export const articleSidebarPayloadSchema = z
  .object({
    current_article_id: z.string().nullable(),
    articles: z.array(articleWithMetaSchema),
  })
  .strict();
export type ArticleSidebarPayload = z.infer<typeof articleSidebarPayloadSchema>;

export const articleSchema = z
  .object({
    ...articleBaseShape,
    content: z.string(),
    is_bookmarked: z.boolean().optional(),
  })
  .strict();
export type Article = z.infer<typeof articleSchema>;

export const articleWithContentAndMetaSchema = articleWithMetaSchema
  .extend({
    content: z.string(),
  })
  .strict();

/** Max characters returned per text segment API response. */
export const SEGMENT_SIZE = TEXT_ARTICLE_SEGMENT_SIZE;

export const READING_HEARTBEAT_SECONDS = 15;
export const READING_HISTORY_MIN_SECONDS = 30;
export const READING_HISTORY_LIMIT = 3;
