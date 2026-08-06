const LAST_CHROME_WITH_SEGMENTED_ARTICLE_STORAGE = 80;

/**
 * Chrome 80 and older need small, independently committed IndexedDB values to
 * avoid the browser's Blob transaction failure. Newer Chrome versions retain
 * the aggregate representation to avoid creating many resource records.
 */
export function shouldSegmentArticleStorage(userAgent: string): boolean {
  const match = /\b(?:Chrome|Chromium)\/(\d+)/.exec(userAgent);
  if (!match) return false;
  return Number(match[1]) <= LAST_CHROME_WITH_SEGMENTED_ARTICLE_STORAGE;
}
