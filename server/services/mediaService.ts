import type { Database } from "better-sqlite3";
import type { MediaRuntime } from "@/server/runtime/mediaRuntime";
import {
  ensureTrack,
  getTrack,
  listTracks,
  mediaConfig,
  touchTrack,
  updateMediaConfig,
  type TrackInput,
} from "@/server/data/media";
import { issueStreamGrant } from "@/server/runtime/mediaRuntime";
import { MediaError } from "@/lib/media";
import { PublicError } from "@/server/services/incidentService";
import { publishSystem, publishUser } from "@/server/services/eventBus";
import { QuotaService } from "@/server/storage/quotaService";

export function mapMediaError(error: unknown): PublicError {
  if (error instanceof MediaError) {
    const messages: Record<string, string> = {
      "not-found": "该曲目当前不可用",
      "rate-limited": "媒体后端正在冷却，请稍后重试",
      "provider-unavailable": "媒体后端暂时不可用",
      "pot-unavailable": "PO Token 服务不可用，请稍后重试",
      timeout: "媒体后端响应超时，请稍后重试",
      "output-too-large": "媒体后端返回数据过大",
      "invalid-payload": "媒体后端返回数据无效",
      cancelled: "媒体请求已取消",
      "backend-missing": "多媒体功能未配置",
    };
    return new PublicError(messages[error.kind] ?? error.message);
  }
  return new PublicError("媒体服务发生错误");
}

export class MediaService {
  constructor(
    private readonly db: Database,
    private readonly runtime: MediaRuntime,
  ) {}

  async search(query: string, limit: number) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40_000);
    timeout.unref();
    try {
      const hits = await this.runtime.search(query, limit, controller.signal);
      const tracks = hits.map(({ track, coverUrl }) =>
        ensureTrack(this.db, {
          source: track.source,
          providerId: track.providerId,
          canonicalUrl: track.canonicalUrl,
          title: track.title,
          artists: [...track.artists],
          album: track.album,
          durationMs: track.durationMs,
          thumbnailUrl: coverUrl,
        }),
      );
      for (const track of tracks) {
        publishSystem({
          kind: "media.track.changed",
          data: { track_id: track.id },
        });
      }
      return tracks;
    } catch (error) {
      throw mapMediaError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  ensureTrack(input: TrackInput) {
    const track = ensureTrack(this.db, input);
    publishSystem({
      kind: "media.track.changed",
      data: { track_id: track.id },
    });
    return track;
  }

  track(trackId: string) {
    return getTrack(this.db, trackId);
  }

  tracks(ids: string[]) {
    return listTracks(this.db, ids);
  }

  /** Authoritative playback intent: touch, start materialization, issue grant. */
  play(userId: string, trackId: string) {
    const track = getTrack(this.db, trackId);
    if (!track) throw new PublicError("曲目不存在");
    touchTrack(this.db, trackId);
    new QuotaService(this.db).touch("media", trackId);
    void this.runtime.ensureMaterialized(track, "audio").catch(() => undefined);
    void this.runtime.ensureMaterialized(track, "cover").catch(() => undefined);
    const grant = issueStreamGrant(this.db, trackId, userId);
    publishUser(userId, {
      kind: "media.track.changed",
      data: { track_id: trackId },
    });
    return {
      grant_token: grant.token,
      url: `/api/media/tracks/${encodeURIComponent(trackId)}/audio?grant=${encodeURIComponent(grant.token)}`,
      expires_at: grant.expiresAt,
    };
  }

  /** Start background materialization for a queued track without granting playback. */
  prepare(trackId: string): void {
    const track = getTrack(this.db, trackId);
    if (!track) throw new PublicError("曲目不存在");
    void this.runtime.ensureMaterialized(track, "audio").catch(() => undefined);
    void this.runtime.ensureMaterialized(track, "cover").catch(() => undefined);
  }

  updateConfig(input: {
    max_volume?: number;
    eviction_days?: number;
    storage_limit_bytes?: number;
  }) {
    const config = {
      ...updateMediaConfig(this.db, input),
      enabled: this.runtime.available,
    };
    publishSystem({
      kind: "media.config.changed",
      data: config,
    });
    return config;
  }

  config() {
    return { ...mediaConfig(this.db), enabled: this.runtime.available };
  }
}
