import { z } from "zod";

export const FEATURES = [
  "offline",
  "articles",
  "article_reader",
  "ebook_reader",
  "learning",
  "article_download",
  "ai",
  "media",
  "post_images",
] as const;

export type Feature = (typeof FEATURES)[number];

export const FEATURE_LABELS: Record<Feature, string> = {
  offline: "离线功能",
  articles: "文章",
  article_reader: "文章阅读器",
  ebook_reader: "电子书阅读器",
  learning: "学习功能",
  article_download: "文章下载",
  ai: "AI 对话",
  media: "多媒体",
  post_images: "图片上传",
};

const featureShape = Object.fromEntries(
  FEATURES.map((feature) => [feature, z.boolean()]),
) as Record<Feature, z.ZodBoolean>;

export const userFeaturesSchema = z.object(featureShape).strict();
export type UserFeatures = z.infer<typeof userFeaturesSchema>;

export const DEFAULT_USER_FEATURES = Object.freeze(
  Object.fromEntries(
    FEATURES.map((feature) => [feature, true]),
  ) as UserFeatures,
);

export function hasFeature(
  user: { features: UserFeatures } | null | undefined,
  feature: Feature,
): boolean {
  return user?.features[feature] === true;
}
