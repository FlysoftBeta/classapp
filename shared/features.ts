export const FEATURE_GATES = [
  "admin",
  "offline",
  "articles",
  "article_reader",
  "ebook_reader",
  "learning",
  "article_download",
] as const;

export type FeatureGate = (typeof FEATURE_GATES)[number];

export const FEATURE_GATE_LABELS: Record<FeatureGate, string> = {
  admin: "管理员功能",
  offline: "离线功能",
  articles: "文章",
  article_reader: "文章阅读器",
  ebook_reader: "电子书阅读器",
  learning: "学习功能",
  article_download: "文章下载",
};

export const DEFAULT_FEATURE_MASK = 126;
export const ADMIN_FEATURE_MASK = 127;

export function featureBit(gate: FeatureGate): number {
  return 1 << FEATURE_GATES.indexOf(gate);
}

export function hasFeature(
  user: { feature_mask: number } | null | undefined,
  gate: FeatureGate,
): boolean {
  return !!user && (user.feature_mask & featureBit(gate)) !== 0;
}

export function setFeature(mask: number, gate: FeatureGate, enabled: boolean) {
  const bit = featureBit(gate);
  return enabled ? mask | bit : mask & ~bit;
}
