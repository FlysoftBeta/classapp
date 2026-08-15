import { z } from "zod";
import { TEXT_ARTICLE_SEGMENT_SIZE } from "@/shared/articles/segments";
import { userMetadataSchema } from "./user";

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
      type: z.literal("bundle"),
      source_file: z.string(),
      archive_file: z.string(),
      source_mime: z.string(),
      source_bytes: z.number().int().nonnegative(),
      archive_bytes: z.number().int().nonnegative(),
      original_name: z.string().nullable().optional(),
      items: z.number().int().nonnegative(),
    }),
  ]),
  content_kind: z.enum(["text", "bundle"]),
  source_path: z.string().nullable().optional(),
  archive_path: z.string().nullable().optional(),
  mime_type: z.string().nullable().optional(),
  file_size: z.number().nonnegative(),
  original_filename: z.string().nullable().optional(),
  created_at: z.string(),
};

export const articleWithMetaSchema = z
  .object({
    ...articleBaseShape,
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

/** Article rows plus the deduplicated author-identity side bundle. */
export const articleSidebarPayloadSchema = z
  .object({
    current_article_id: z.string().nullable(),
    articles: z.array(articleWithMetaSchema),
    users: z.array(userMetadataSchema),
  })
  .strict();
export type ArticleSidebarPayload = z.infer<typeof articleSidebarPayloadSchema>;

/** Max characters returned per text segment API response. */
export const SEGMENT_SIZE = TEXT_ARTICLE_SEGMENT_SIZE;

export const READING_HEARTBEAT_SECONDS = 15;
export const READING_HISTORY_MIN_SECONDS = 30;
export const READING_HISTORY_LIMIT = 3;
