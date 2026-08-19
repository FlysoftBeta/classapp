export type ConversationDownloadPolicy = "auto" | "week" | "half-year";
export type ArticleDownloadPolicy =
  | { mode: "auto" }
  | { mode: "retained"; days: 1 | 7 | 180; expiresAt: number };

export const ARTICLE_RETENTION_DAYS = [1, 7, 180] as const;
export const CONVERSATION_RETENTION_DAYS = {
  auto: 0,
  week: 7,
  "half-year": 180,
} as const satisfies Record<ConversationDownloadPolicy, number>;

const MS_PER_DAY = 86_400_000;

/** Inclusive lower bound for conversation posts kept under a retention policy. */
export function conversationRetentionCutoff(
  policy: ConversationDownloadPolicy,
  now = Date.now(),
): number | null {
  const days = CONVERSATION_RETENTION_DAYS[policy];
  return days ? now - days * MS_PER_DAY : null;
}

export function articleRetentionExpiry(
  days: (typeof ARTICLE_RETENTION_DAYS)[number],
  now = Date.now(),
): number {
  return now + days * MS_PER_DAY;
}

/** Auto policies and unexpired retained policies still justify keeping bytes. */
export function articleRetentionActive(
  policy: ArticleDownloadPolicy,
  now = Date.now(),
): boolean {
  return policy.mode !== "retained" || policy.expiresAt > now;
}
