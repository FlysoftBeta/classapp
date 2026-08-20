import type { MediaTrack } from "@/shared/media/types";
import { lbAssetUrl } from "@/client/lib/loadBalancer";
import { trackCapability } from "@/client/interact/capabilities";

/** Session-authenticated server cover route; never external image URLs. */
export function coverUrlForTrack(trackId: string, token: string): string {
  const capability = trackCapability(trackId);
  const extra = capability
    ? `&capability=${encodeURIComponent(capability)}`
    : "";
  return lbAssetUrl(
    `/api/media/tracks/${encodeURIComponent(trackId)}/cover?token=${encodeURIComponent(token)}${extra}`,
  );
}

/** Only show a row cover once the server materialized it. */
export function trackCoverUrl(
  track: MediaTrack,
  token: string | null,
): string | null {
  if (!token || track.materialization.cover.state !== "ready") return null;
  return coverUrlForTrack(track.id, token);
}

/**
 * Playlist summaries carry only the first track id. The cover route waits for
 * the cover job on first access, so it can be requested before `ready`.
 */
export function playlistCoverUrl(
  coverTrackId: string | null,
  token: string | null,
): string | null {
  if (!coverTrackId || !token) return null;
  return coverUrlForTrack(coverTrackId, token);
}
