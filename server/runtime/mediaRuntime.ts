import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Database } from "better-sqlite3";
import {
  MediaError,
  PotServerSupervisor,
  YtDlpProvider,
  type LiveStreamHandle,
  type MediaProgressFn,
  type ProviderTrack,
} from "@/lib/media";
import type { MediaRuntimeConfig } from "@/server/infra/runtimeConfig";
import type { MediaTrack } from "@/shared/media/types";
import {
  deleteAssetsIfUnreferenced,
  deleteExpiredQueues,
  deleteExpiredStreamGrants,
  findReadyAsset,
  listExpiredEvictionCandidates,
  listLruEvictionCandidates,
  markAssetDownloading,
  markAssetFailed,
  publishAsset,
  readyAssetBytes,
  mediaConfig,
  listAssets,
} from "@/server/data/media";
import {
  createMediaObjectStore,
  type MediaObjectStore,
} from "@/server/infra/mediaStore";
import { publishSystem } from "@/server/services/eventBus";
import { recordContainedServerIncident } from "@/server/services/incidentService";
import { BUILD_ID } from "@/server/infra/env";

interface MaterializationJob {
  trackId: string;
  kind: "audio" | "cover";
  promise: Promise<void>;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function trackToProvider(track: MediaTrack): ProviderTrack {
  return {
    source: track.source,
    providerId: track.provider_id,
    canonicalUrl: track.canonical_url,
    title: track.title,
    artists: track.artists,
    album: track.album,
    durationMs: track.duration_ms,
    thumbnailUrl: track.thumbnail_url,
  };
}

/**
 * Process-lifetime media mechanisms: provider, POT supervisor, materialization
 * jobs, stream leases and storage eviction. Never captures Scope or Actor.
 */
export class MediaRuntime {
  private provider: YtDlpProvider;
  private readonly pot: PotServerSupervisor;
  readonly objects: MediaObjectStore;
  private readonly jobs = new Map<string, MaterializationJob>();
  private readonly leases = new Map<string, number>();
  private readonly waiters = new Map<string, ReadyWaiter[]>();
  private started = false;

  constructor(
    private readonly db: Database,
    private readonly config: MediaRuntimeConfig,
    objectRoot: string,
  ) {
    this.objects = createMediaObjectStore(objectRoot);
    const configured =
      config.ytDlpPath !== null &&
      config.ytDlpPath !== "" &&
      existsSync(config.ytDlpPath);
    this.provider = new YtDlpProvider({
      binaryPath: configured ? config.ytDlpPath : null,
      nodePath: process.execPath,
      pluginDirs: config.pluginDirs,
    });
    this.pot = new PotServerSupervisor({
      entry: config.potServerEntry,
    });
  }

  get available(): boolean {
    return (
      this.config.ytDlpPath !== null &&
      this.config.ytDlpPath !== "" &&
      existsSync(this.config.ytDlpPath)
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.available) {
      console.warn("[Media] yt-dlp path is not configured; media is disabled");
      return;
    }
    try {
      const baseUrl = await this.pot.start();
      this.provider = new YtDlpProvider({
        binaryPath: this.config.ytDlpPath,
        nodePath: process.execPath,
        pluginDirs: this.config.pluginDirs,
        potBaseUrl: baseUrl,
      });
      console.log(
        baseUrl
          ? `[Media] POT provider ready at ${baseUrl}`
          : "[Media] POT provider not configured",
      );
    } catch (error) {
      recordContainedServerIncident(this.db, BUILD_ID, error, {
        component: "media-runtime",
        phase: "pot-start",
      });
      console.warn("[Media] POT provider unavailable", error);
    }
    await this.objects.reconcile();
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const job of this.jobs.values()) void job.promise.catch(() => undefined);
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new MediaError("cancelled", "媒体服务已停止"));
      }
    }
    this.waiters.clear();
    this.leases.clear();
    await this.pot.stop();
  }

  search(query: string, limit: number, signal: AbortSignal) {
    return this.provider.search(query, limit, signal);
  }

  /** Start a background materialization; returns the current job promise. */
  ensureMaterialized(track: MediaTrack, kind: "audio" | "cover"): Promise<void> {
    const key = `${track.id}:${kind}`;
    const existing = this.jobs.get(key);
    if (existing) return existing.promise;
    const promise = this.runMaterialization(track, kind);
    this.jobs.set(key, { trackId: track.id, kind, promise });
    void promise.finally(() => {
      if (this.jobs.get(key)?.promise === promise) this.jobs.delete(key);
    });
    return promise;
  }

  private async runMaterialization(
    track: MediaTrack,
    kind: "audio" | "cover",
  ): Promise<void> {
    try {
      const ready = findReadyAsset(this.db, track.id, kind);
      if (ready) return;
      markAssetDownloading(this.db, track.id, kind);
      const stagePath = this.objects.stagePath(kind, track.id);
      let lastProgressAt = 0;
      const onProgress: MediaProgressFn = (percent) => {
        if (!this.started) return;
        const now = Date.now();
        if (percent !== null && now - lastProgressAt < 1_000) return;
        lastProgressAt = now;
        publishSystem({
          kind: "media.materialization.changed",
          data: {
            track_id: track.id,
            audio_state: kind === "audio" ? "downloading" : audioState(this.db, track.id),
            audio_progress:
              kind === "audio" && percent !== null ? Math.floor(percent) : null,
            cover_state: kind === "cover" ? "downloading" : coverState(this.db, track.id),
          },
        });
      };
      const result =
        kind === "audio"
          ? await this.provider.download(
              trackToProvider(track),
              stagePath,
              onProgress,
              new AbortController().signal,
            )
          : await this.provider.downloadCover(
              trackToProvider(track),
              stagePath,
              new AbortController().signal,
            );
      const objectPath = await this.objects.publish(kind, track.id);
      publishAsset(this.db, track.id, kind, {
        objectPath,
        mime: result.mime,
        bytes: result.bytes,
        sha256: result.sha256,
      });
      this.resolveWaiters(`${track.id}:${kind}`);
      publishSystem({
        kind: "media.materialization.changed",
        data: {
          track_id: track.id,
          audio_state: audioState(this.db, track.id),
          audio_progress: null,
          cover_state: coverState(this.db, track.id),
        },
      });
    } catch (error) {
      await rm(this.objects.stagePath(kind, track.id), {
        force: true,
      }).catch(() => undefined);
      const code =
        error instanceof MediaError
          ? error.kind
          : "materialization-failed";
      markAssetFailed(this.db, track.id, kind, code);
      publishSystem({
        kind: "media.materialization.changed",
        data: {
          track_id: track.id,
          audio_state: audioState(this.db, track.id),
          audio_progress: null,
          cover_state: coverState(this.db, track.id),
        },
      });
      if (error instanceof MediaError && error.kind === "cancelled") return;
      recordContainedServerIncident(this.db, BUILD_ID, error, {
        component: "media-runtime",
        phase: `materialize-${kind}`,
        track_id: track.id,
      });
    }
  }

  /** Live relay for a metadata-only track. Backfill materialization runs too. */
  async openLiveStream(
    track: MediaTrack,
    signal: AbortSignal,
  ): Promise<LiveStreamHandle> {
    void this.ensureMaterialized(track, "audio").catch(() => undefined);
    const handle = await this.provider.openLiveStream(
      trackToProvider(track),
      (percent) => {
        if (!this.started) return;
        publishSystem({
          kind: "media.materialization.changed",
          data: {
            track_id: track.id,
            audio_state: "downloading",
            audio_progress: percent === null ? null : Math.floor(percent),
            cover_state: coverState(this.db, track.id),
          },
        });
      },
      signal,
    );
    this.touchOnStreamStart(track.id);
    return handle;
  }

  private touchOnStreamStart(trackId: string): void {
    this.db
      .prepare("UPDATE media_tracks SET last_used_at = datetime('now') WHERE id = ?")
      .run(trackId);
  }

  acquireLease(trackId: string): () => void {
    this.leases.set(trackId, (this.leases.get(trackId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.leases.get(trackId) ?? 1) - 1;
      if (count <= 0) this.leases.delete(trackId);
      else this.leases.set(trackId, count);
    };
  }

  hasLease(trackId: string): boolean {
    return (this.leases.get(trackId) ?? 0) > 0;
  }

  async waitUntilReady(
    track: MediaTrack,
    kind: "audio" | "cover",
    timeoutMs: number,
  ): Promise<boolean> {
    if (findReadyAsset(this.db, track.id, kind)) return true;
    const key = `${track.id}:${kind}`;
    if ((this.waiters.get(key)?.length ?? 0) >= 16) {
      throw new MediaError("rate-limited", "等待该曲目的请求过多", true);
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new MediaError("timeout", "等待媒体就绪超时", true));
      }, timeoutMs);
      const waiters = this.waiters.get(key) ?? [];
      waiters.push({ resolve, reject, timeout });
      this.waiters.set(key, waiters);
    }).catch((error) => {
      if (error instanceof MediaError && error.kind === "timeout") return;
      throw error;
    });
    return findReadyAsset(this.db, track.id, kind) !== null;
  }

  private resolveWaiters(key: string): void {
    const waiters = this.waiters.get(key) ?? [];
    this.waiters.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }

  /** Hybrid eviction: 7-day age sweep first, then the 4 GiB high watermark. */
  async reconcileStorage(): Promise<void> {
    deleteExpiredStreamGrants(this.db);
    deleteExpiredQueues(this.db);
    await this.objects.reconcile();
    const config = mediaConfig(this.db);
    const expired = listExpiredEvictionCandidates(
      this.db,
      config.eviction_days,
      100,
    );
    for (const candidate of expired) await this.evict(candidate.trackId);
    const limit = config.storage_limit_bytes;
    const target = Math.floor(limit * 0.8);
    while (readyAssetBytes(this.db) > limit) {
      const candidates = listLruEvictionCandidates(this.db, 50);
      if (candidates.length === 0) break;
      let reclaimed = false;
      for (const candidate of candidates) {
        if (!(await this.evict(candidate.trackId))) continue;
        reclaimed = true;
        if (readyAssetBytes(this.db) <= target) break;
      }
      if (!reclaimed) break;
    }
  }

  private async evict(trackId: string): Promise<boolean> {
    if (this.hasLease(trackId)) return false;
    const paths = this.db.transaction(() =>
      deleteAssetsIfUnreferenced(this.db, trackId),
    )();
    if (paths === null || paths.length === 0) return false;
    for (const objectPath of paths) await this.objects.trash(objectPath);
    publishSystem({
      kind: "media.materialization.changed",
      data: {
        track_id: trackId,
        audio_state: "absent",
        audio_progress: null,
        cover_state: "absent",
      },
    });
    return true;
  }
}

function audioState(
  db: Database,
  trackId: string,
): "absent" | "queued" | "downloading" | "ready" | "failed" {
  return assetState(db, trackId, "audio");
}

function coverState(
  db: Database,
  trackId: string,
): "absent" | "queued" | "downloading" | "ready" | "failed" {
  return assetState(db, trackId, "cover");
}

function assetState(
  db: Database,
  trackId: string,
  kind: "audio" | "cover",
): "absent" | "queued" | "downloading" | "ready" | "failed" {
  const row = listAssets(db, trackId).find((asset) => asset.kind === kind);
  return row?.state ?? "absent";
}

/** Generate a short-lived grant used by the raw audio HTTP route. */
export function issueStreamGrant(
  db: Database,
  trackId: string,
  userId: string | null,
  ttlMs = 10 * 60_000,
): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + ttlMs;
  db.prepare(
    `INSERT INTO media_stream_grants (token, track_id, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(token, trackId, userId, expiresAt, Date.now());
  return { token, expiresAt };
}
