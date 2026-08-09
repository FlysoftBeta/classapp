function articlePrefix(articleId: string): string {
  return `article:${articleId}:`;
}

function articleBundlePrefix(articleId: string): string {
  return `${articlePrefix(articleId)}bundle:`;
}

/** Stable logical file identities. Physical generations remain private to files.ts. */
export const FileIds = {
  articlePrefix,
  articleBundlePrefix,
  articleBundleCatalog(articleId: string): string {
    return `${articleBundlePrefix(articleId)}catalog`;
  },
  articleBundleResource(articleId: string, contentId: string): string {
    return `${articleBundlePrefix(articleId)}resource:${contentId}`;
  },
  articleId(fileId: string): string | null {
    const match = /^article:([^:]+):/.exec(fileId);
    return match?.[1] ?? null;
  },
} as const;
