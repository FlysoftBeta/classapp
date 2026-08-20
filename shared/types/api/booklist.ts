import { z } from "zod";
import {
  accessFlagsSchema,
  capabilityTokenSchema,
} from "@/shared/access";
import { articleWithMetaSchema } from "./article";
import { userMetadataSchema } from "./user";

const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const booklistSummarySchema = object({
  id: z.string(),
  title: z.string(),
  revision: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  item_count: z.number().int().nonnegative(),
  origin_group_id: z.string().nullable(),
  access: accessFlagsSchema,
});

export const booklistItemSchema = object({
  article_id: z.string(),
  position: z.number().int().nonnegative(),
  added_at: z.string(),
});

export const signedArticleSchema = object({
  article: articleWithMetaSchema,
  capability: capabilityTokenSchema,
});

export const booklistSnapshotSchema = object({
  list: booklistSummarySchema,
  items: z.array(booklistItemSchema),
  articles: z.array(articleWithMetaSchema),
  users: z.array(userMetadataSchema),
});

export type BooklistSummary = z.output<typeof booklistSummarySchema>;
export type BooklistItem = z.output<typeof booklistItemSchema>;
export type BooklistSnapshot = z.output<typeof booklistSnapshotSchema>;
export type SignedArticle = z.output<typeof signedArticleSchema>;
