import { z } from "zod";
import { accessFlagsSchema, capabilityTokenSchema } from "@/shared/access";

const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const mediaAssetStateSchema = z.enum([
  "absent",
  "queued",
  "downloading",
  "ready",
  "failed",
]);

export const mediaAssetSchema = object({
  state: mediaAssetStateSchema,
  mime: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  downloaded_at: z.string().nullable(),
});

export const mediaTrackSchema = object({
  id: z.string(),
  source: z.string(),
  provider_id: z.string(),
  canonical_url: z.string(),
  title: z.string(),
  artists: z.array(z.string()),
  album: z.string().nullable(),
  duration_ms: z.number().int().nonnegative(),
  thumbnail_url: z.string().nullable(),
  metadata_revision: z.number().int().nonnegative(),
  last_used_at: z.string().nullable(),
  created_at: z.string(),
  materialization: object({
    audio: mediaAssetSchema,
    cover: mediaAssetSchema,
  }),
});

export const mediaListItemSchema = object({
  track_id: z.string(),
  position: z.number().int().nonnegative(),
  added_at: z.string(),
});

export const signedMediaTrackSchema = object({
  track: mediaTrackSchema,
  capability: capabilityTokenSchema,
});

export const mediaPlaylistSummarySchema = object({
  id: z.string(),
  title: z.string(),
  revision: z.number().int().nonnegative(),
  retention_days: z.number().int().positive().max(365),
  created_at: z.string(),
  updated_at: z.string(),
  track_count: z.number().int().nonnegative(),
  cover_track_id: z.string().nullable(),
  origin_group_id: z.string().nullable(),
  access: accessFlagsSchema,
});

export const mediaListSnapshotSchema = object({
  list: mediaPlaylistSummarySchema,
  items: z.array(mediaListItemSchema),
  tracks: z.array(signedMediaTrackSchema),
});

export const mediaQueueSnapshotSchema = mediaListSnapshotSchema;
export const mediaPlaylistSnapshotSchema = mediaListSnapshotSchema;

export const mediaConfigSchema = object({
  enabled: z.boolean(),
  max_volume: z.number().min(0).max(1),
  eviction_days: z.number().int().positive(),
  storage_limit_bytes: z.number().int().positive(),
});

export const mediaTrackChangedEventSchema = object({
  track_id: z.string(),
});

export const mediaPlaylistChangedEventSchema = object({
  playlist_id: z.string(),
  revision: z.number().int().nonnegative(),
});

export const mediaQueueChangedEventSchema = object({
  revision: z.number().int().nonnegative(),
});

export const mediaConfigChangedEventSchema = mediaConfigSchema;

export const mediaMaterializationChangedEventSchema = object({
  track_id: z.string(),
  audio_state: mediaAssetStateSchema,
  audio_progress: z.number().int().min(0).max(100).nullable(),
  cover_state: mediaAssetStateSchema,
});

export type MediaAsset = z.output<typeof mediaAssetSchema>;
export type MediaTrack = z.output<typeof mediaTrackSchema>;
export type SignedMediaTrack = z.output<typeof signedMediaTrackSchema>;
export type MediaListItem = z.output<typeof mediaListItemSchema>;
export type MediaListSnapshot = z.output<typeof mediaListSnapshotSchema>;
export type MediaPlaylistSummary = z.output<typeof mediaPlaylistSummarySchema>;
export type MediaConfig = z.output<typeof mediaConfigSchema>;

/** Local/presentation view of a signed list snapshot after capabilities are cached. */
export interface MediaListView {
  list: MediaPlaylistSummary;
  items: MediaListItem[];
  tracks: MediaTrack[];
}

export function mediaListView(snapshot: MediaListSnapshot): MediaListView {
  return {
    list: snapshot.list,
    items: snapshot.items,
    tracks: snapshot.tracks.map((row) => row.track),
  };
}

export function findSnapshotTrack(
  snapshot: MediaListView,
  trackId: string,
): MediaTrack | undefined {
  return snapshot.tracks.find((track) => track.id === trackId);
}
