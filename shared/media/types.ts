import { z } from "zod";

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

export const mediaPlaylistSummarySchema = object({
  id: z.string(),
  title: z.string(),
  revision: z.number().int().nonnegative(),
  retention_days: z.number().int().positive().max(365),
  created_at: z.string(),
  updated_at: z.string(),
  track_count: z.number().int().nonnegative(),
  cover_track_id: z.string().nullable(),
});

export const mediaListSnapshotSchema = object({
  list: mediaPlaylistSummarySchema,
  items: z.array(mediaListItemSchema),
  tracks: z.array(mediaTrackSchema),
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
export type MediaListItem = z.output<typeof mediaListItemSchema>;
export type MediaListSnapshot = z.output<typeof mediaListSnapshotSchema>;
export type MediaPlaylistSummary = z.output<typeof mediaPlaylistSummarySchema>;
export type MediaConfig = z.output<typeof mediaConfigSchema>;
