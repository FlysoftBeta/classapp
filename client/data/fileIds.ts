/** Stable logical file identities. Physical generations remain private to files.ts. */
export const FileIds = {
  articleBlob(articleId: string): string {
    return `article:${articleId}:blob`;
  },
  articleId(fileId: string): string | null {
    const match = /^article:(.+):blob$/.exec(fileId);
    return match?.[1] ?? null;
  },
} as const;
