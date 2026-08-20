import type { MediaListSnapshot, MediaListView, MediaTrack, SignedMediaTrack } from "@/shared/media/types";

const trackTokens = new Map<string, string>();
const articleTokens = new Map<string, string>();

export function rememberTrackCapability(id: string, token: string): void {
  trackTokens.set(id, token);
}

export function trackCapability(id: string): string | undefined {
  return trackTokens.get(id);
}

export function rememberSignedTracks(
  rows: readonly SignedMediaTrack[],
): MediaTrack[] {
  return rows.map((row) => {
    rememberTrackCapability(row.track.id, row.capability);
    return row.track;
  });
}

export function adoptMediaListSnapshot(
  snapshot: MediaListSnapshot,
): MediaListView {
  return {
    list: snapshot.list,
    items: snapshot.items,
    tracks: rememberSignedTracks(snapshot.tracks),
  };
}

export function rememberArticleCapability(
  id: string,
  token: string | undefined,
): void {
  if (token) articleTokens.set(id, token);
}

export function articleCapability(id: string): string | undefined {
  return articleTokens.get(id);
}

export function rememberArticleCapabilities(
  articles: ReadonlyArray<{ id: string; capability?: string }>,
): void {
  for (const article of articles) {
    rememberArticleCapability(article.id, article.capability);
  }
}
