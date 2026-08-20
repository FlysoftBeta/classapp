import { z } from "zod";
import { capabilityTokenSchema } from "@/shared/access";

export const BUNDLE_STREAM_MAGIC = "CABSTRM1";
export const BUNDLE_STREAM_VERSION = 1;
export const BUNDLE_RESOURCE_LIMIT = 64;

export const bundleContentIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const bundleResourceSchema = z
  .object({
    content_id: bundleContentIdSchema,
    mime: z.string().min(1).max(255),
    encoding: z.enum(["identity", "zstd", "zstd-dictionary"]),
    raw_size: z.number().int().nonnegative(),
    stored_size: z.number().int().nonnegative(),
  })
  .strict();
export type BundleResource = z.infer<typeof bundleResourceSchema>;

export const bundleItemSchema = z
  .object({
    id: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
    document: bundleContentIdSchema,
    dependencies: z.array(bundleContentIdSchema),
  })
  .strict();
export type BundleItem = z.infer<typeof bundleItemSchema>;

export const bundleHeaderSchema = z
  .object({
    protocol_version: z.literal(BUNDLE_STREAM_VERSION),
    layout: z.literal("fixed"),
    source_mime: z.string().min(1),
    item_count: z.number().int().nonnegative(),
    dictionary: bundleResourceSchema.nullable(),
    shared: z.array(bundleContentIdSchema),
  })
  .strict();
export type BundleHeader = z.infer<typeof bundleHeaderSchema>;

export const bundleSliceSchema = z
  .object({
    header: bundleHeaderSchema,
    items: z.array(bundleItemSchema),
    resources: z.array(bundleResourceSchema),
    exhausted_before: z.boolean(),
    exhausted_after: z.boolean(),
  })
  .strict();
export type BundleSlice = z.infer<typeof bundleSliceSchema>;

export const bundleOpenInputSchema = z
  .object({
    articleId: z.string().min(1),
    cursor: z.number().int().nonnegative().nullable(),
    before: z.number().int().min(0).max(32),
    after: z.number().int().min(1).max(64),
    capability: capabilityTokenSchema.optional(),
  })
  .strict();

export const bundleFetchInputSchema = z
  .object({
    articleId: z.string().min(1),
    cursor: z.number().int().nonnegative(),
    direction: z.enum(["before", "after"]),
    limit: z.number().int().min(1).max(64),
    capability: capabilityTokenSchema.optional(),
  })
  .strict();

export const bundleResourceRequestSchema = z
  .object({
    content_ids: z
      .array(bundleContentIdSchema)
      .min(1)
      .max(BUNDLE_RESOURCE_LIMIT),
  })
  .strict();
