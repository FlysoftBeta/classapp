import type { ProviderTrack } from "./types";

/** Public facts a provider needs to resolve a track into a stream. */
export interface ProviderTrackFacts {
  source: string;
  providerId: string;
  canonicalUrl: string;
  title: string;
  artists: readonly string[];
  album: string | null;
  durationMs: number;
}

interface ProviderTrackHints {
  coverUrl: string | null;
}

const hints = new WeakMap<ProviderTrack, ProviderTrackHints>();

/**
 * Build a provider track from server-owned facts. The cover locator is kept
 * beside the object, not on it: callers ask `streamCover(track)` and never
 * need to read or understand provider-specific URLs.
 */
export function createProviderTrack(
  facts: ProviderTrackFacts,
  coverUrl: string | null,
): ProviderTrack {
  const track: ProviderTrack = Object.freeze({
    ...facts,
    artists: [...facts.artists],
  });
  hints.set(track, { coverUrl });
  return track;
}

/**
 * Provider/adapter-only accessor. Deliberately not re-exported from the
 * library entrypoint so the public surface stays stream-only.
 */
export function coverUrlOf(track: ProviderTrack): string | null {
  return hints.get(track)?.coverUrl ?? null;
}
