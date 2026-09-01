import crypto from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Database } from "better-sqlite3";
import {
  MediaError,
  YtDlpProvider,
  createProviderTrack,
  type ProviderStream,
  type ProviderTrack,
} from "@/lib/media";
import { coverUrlOf } from "@/lib/media/track";
import { PotServerSupervisor } from "@/server/runtime/potServer";
import {
  ConcurrencyLimiter,
  LayerThrottle,
} from "@/server/runtime/mediaThrottle";
import {
  AudioStreamSession,
  type StreamSubscription,
} from "@/server/runtime/mediaStreamSession";
import type { MediaRuntimeConfig } from "@/server/infra/runtimeConfig";
import type { MediaTrack } from "@/shared/media/types";
import {
  deleteAssetsIfUnreferenced,
  deleteExpiredStreamGrants,
  findReadyAsset,
  listAssets,
  markAssetDownloading,
  markAssetFailed,
  mediaQuotaPolicy,
  publishAsset,
  readyAssetBytesForTrack,
  reconcileReadyAssetQuotaItems,
  touchTrack,
} from "@/server/data/media";
import { reclaimExpiredQueues } from "@/server/services/mediaPlaylistService";
import { BlobStore, type StagingSlot } from "@/server/storage/blobStore";
import { QuotaService, type QuotaItem } from "@/server/storage/quotaService";
import { publishSystem } from "@/server/runtime/eventBus";
import { recordContainedServerIncident } from "@/server/services/incidentService";
import { BUILD_ID } from "@/server/infra/env";

const MAX_CONCURRENT_AUDIO_STREAMS = 4;
const STREAM_SLOT_WAIT_MS = 30_000;
const ADMISSION_PIN_MS = 20 * 60_000;

interface MaterializationJob {
  trackId: string;
  kind: "audio" | "cover";
  promise: Promise<void>;
}

export interface MediaSearchHit {
  track: ProviderTrack;
  /** Hidden cover locator for server catalog persistence, not for playback. */
  coverUrl: string | null;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function trackToProvider(track: MediaTrack): ProviderTrack {
  return createProviderTrack(
    {
      source: track.source,
      providerId: track.provider_id,
      canonicalUrl: track.canonical_url,
      title: track.title,
      artists: track.artists,
      album: track.album,
      durationMs: track.duration_ms,
    },
    track.thumbnail_url,
  );
}

/**
 * Process-lifetime media mechanisms: provider, POT supervisor, materialization
 * jobs, stream leases and storage eviction. Never captures Scope or Actor.
 */
export class MediaRuntime {
  private provider: YtDlpProvider;
  private readonly pot: PotServerSupervisor;
  private readonly searchThrottle = new LayerThrottle(5_000);
  private readonly materializeThrottle = new LayerThrottle(1_000);
  private readonly streamStartThrottle = new LayerThrottle(1_000);
  private readonly streamSlots = new ConcurrencyLimiter(
    MAX_CONCURRENT_AUDIO_STREAMS,
    STREAM_SLOT_WAIT_MS,
  );
  readonly blobs: BlobStore;
  private readonly coverJobs = new Map<string, MaterializationJob>();
  private readonly audioSessions = new Map<string, AudioStreamSession>();
  private readonly leases = new Map<string, number>();
  private readonly waiters = new Map<string, ReadyWaiter[]>();
  private started = false;

  constructor(
    private readonly db: Database,
    private readonly config: MediaRuntimeConfig,
    blobs: BlobStore,
  ) {
    this.blobs = blobs;
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
    this.ensureQuotaGroup();
    this.reconcileQuotaItems();
    if (!this.available) {
      console.warn("[Media] yt-dlp path is not configured; media is disabled");
      return;
    }
    // Temporarily skip the GPL POT child process. yt-dlp uses android_vr
    // instead of web_music + bgutil HTTP. Keep PotServerSupervisor in place.
    console.log(
      "[Media] POT provider disabled; using youtube player_client=android_vr",
    );
    // try {
    //   const baseUrl = await this.pot.start();
    //   this.provider = new YtDlpProvider({
    //     binaryPath: this.config.ytDlpPath,
    //     nodePath: process.execPath,
    //     pluginDirs: this.config.pluginDirs,
    //     potBaseUrl: baseUrl,
    //   });
    //   console.log(
    //     baseUrl
    //       ? `[Media] POT provider ready at ${baseUrl}`
    //       : "[Media] POT provider not configured",
    //   );
    // } catch (error) {
    //   recordContainedServerIncident(this.db, BUILD_ID, error, {
    //     component: "media-runtime",
    //     phase: "pot-start",
    //   });
    //   console.warn("[Media] POT provider unavailable", error);
    // }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const session of [...this.audioSessions.values()]) session.dispose();
    this.audioSessions.clear();
    for (const job of this.coverJobs.values())
      void job.promise.catch(() => undefined);
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

  async search(
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<MediaSearchHit[]> {
    const tracks = await this.searchThrottle.run(() =>
      this.provider.search(query, limit, signal),
    );
    return tracks.map((track) => ({
      track,
      coverUrl: coverUrlOf(track),
    }));
  }

  /**
   * Start a background materialization; returns the current job promise.
   * Audio materialization runs through a shared AudioStreamSession so the
   * same provider stream can also feed live relays.
   */
  ensureMaterialized(
    track: MediaTrack,
    kind: "audio" | "cover",
  ): Promise<void> {
    if (kind === "audio") return this.ensureAudioMaterialized(track);
    return this.ensureCoverMaterialized(track);
  }

  private ensureAudioMaterialized(track: MediaTrack): Promise<void> {
    if (findReadyAsset(this.db, track.id, "audio")) return Promise.resolve();
    return (
      this.getOrCreateAudioSession(track).materialization ?? Promise.resolve()
    );
  }

  private ensureCoverMaterialized(track: MediaTrack): Promise<void> {
    const key = `${track.id}:cover`;
    const existing = this.coverJobs.get(key);
    if (existing) return existing.promise;
    const promise = this.runCoverMaterialization(track);
    this.coverJobs.set(key, { trackId: track.id, kind: "cover", promise });
    void promise.finally(() => {
      if (this.coverJobs.get(key)?.promise === promise)
        this.coverJobs.delete(key);
    });
    return promise;
  }

  private getOrCreateAudioSession(track: MediaTrack): AudioStreamSession {
    const existing = this.audioSessions.get(track.id);
    if (existing) return existing;
    const session = new AudioStreamSession({
      findReady: () => findReadyAsset(this.db, track.id, "audio") !== null,
      startProvider: (signal) => this.startAudioProvider(track, signal),
      materializeFrom: (subscription) =>
        this.materializeAudioFrom(track, subscription),
      onDispose: (candidate) => {
        if (this.audioSessions.get(track.id) === candidate) {
          this.audioSessions.delete(track.id);
        }
      },
    });
    this.audioSessions.set(track.id, session);
    return session;
  }

  private async startAudioProvider(
    track: MediaTrack,
    signal: AbortSignal,
  ): Promise<{ stream: ProviderStream; release(): void }> {
    const releaseSlot = await this.streamSlots.acquire(signal);
    try {
      const stream = await this.streamStartThrottle.run(() =>
        this.provider.streamTrack(trackToProvider(track), {
          signal,
          onProgress: (percent) => this.publishAudioProgress(track, percent),
        }),
      );
      return { stream, release: releaseSlot };
    } catch (error) {
      releaseSlot();
      throw error;
    }
  }

  private publishAudioProgress(
    track: MediaTrack,
    percent: number | null,
  ): void {
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
  }

  private async materializeAudioFrom(
    track: MediaTrack,
    subscription: StreamSubscription,
  ): Promise<void> {
    const blobId = crypto.randomUUID();
    let staged: StagingSlot | null = null;
    let committed = false;
    try {
      if (findReadyAsset(this.db, track.id, "audio")) return;
      markAssetDownloading(this.db, track.id, "audio", blobId);
      staged = await this.blobs.create(blobId);
      const materialized = await writeChunks(subscription.read(), staged.path);
      const object = await staged.commit({
        expectedBytes: materialized.bytes,
        sha256: materialized.sha256,
      });
      staged = null;
      committed = true;
      publishAsset(this.db, track.id, "audio", {
        blobId: object.id,
        mime: "audio/webm",
        bytes: materialized.bytes,
        sha256: materialized.sha256,
      });
      this.accountReadyTrack(track.id);
      this.resolveWaiters(`${track.id}:audio`);
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
      await staged?.discard();
      if (committed && !findReadyAsset(this.db, track.id, "audio")) {
        await this.blobs.drop(blobId).catch(() => undefined);
      }
      if (error instanceof MediaError && error.kind === "cancelled") return;
      const code =
        error instanceof MediaError ? error.kind : "materialization-failed";
      markAssetFailed(this.db, track.id, "audio", code);
      publishSystem({
        kind: "media.materialization.changed",
        data: {
          track_id: track.id,
          audio_state: audioState(this.db, track.id),
          audio_progress: null,
          cover_state: coverState(this.db, track.id),
        },
      });
      recordContainedServerIncident(this.db, BUILD_ID, error, {
        component: "media-runtime",
        phase: "materialize-audio",
        track_id: track.id,
      });
    }
  }

  private async runCoverMaterialization(track: MediaTrack): Promise<void> {
    const kind = "cover";
    const blobId = crypto.randomUUID();
    let staged: StagingSlot | null = null;
    let committed = false;
    try {
      const ready = findReadyAsset(this.db, track.id, kind);
      if (ready) return;
      markAssetDownloading(this.db, track.id, kind, blobId);
      staged = await this.blobs.create(blobId);
      const outputPath = staged.path;
      const materialized = await this.materializeThrottle.run(async () => {
        const stream = await this.provider.streamCover(trackToProvider(track), {
          signal: new AbortController().signal,
        });
        return {
          stream,
          ...(await writeProviderStream(stream, outputPath)),
        };
      });
      const object = await staged.commit({
        expectedBytes: materialized.bytes,
        sha256: materialized.sha256,
      });
      staged = null;
      committed = true;
      publishAsset(this.db, track.id, kind, {
        blobId: object.id,
        mime: materialized.stream.contentType,
        bytes: materialized.bytes,
        sha256: materialized.sha256,
      });
      this.accountReadyTrack(track.id);
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
      await staged?.discard();
      if (committed && !findReadyAsset(this.db, track.id, kind)) {
        await this.blobs.drop(blobId).catch(() => undefined);
      }
      if (error instanceof MediaError && error.kind === "cancelled") return;
      const code =
        error instanceof MediaError ? error.kind : "materialization-failed";
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
      recordContainedServerIncident(this.db, BUILD_ID, error, {
        component: "media-runtime",
        phase: `materialize-${kind}`,
        track_id: track.id,
      });
    }
  }

  /**
   * Live relay for a metadata-only track. The relay joins the track's shared
   * AudioStreamSession, so concurrent listeners of the same track (and the
   * background materialization job) share one yt-dlp invocation.
   */
  async streamTrack(
    track: MediaTrack,
    signal: AbortSignal,
  ): Promise<ProviderStream> {
    const ready = findReadyAsset(this.db, track.id, "audio");
    if (ready) {
      // Rare race: the HTTP route checked before calling us and the asset
      // became ready in between. Keep the old direct-relay behavior.
      const stream = await this.provider.streamTrack(trackToProvider(track), {
        signal,
        onProgress: (percent) => this.publishAudioProgress(track, percent),
      });
      this.touchOnStreamStart(track.id);
      return stream;
    }
    this.touchOnStreamStart(track.id);
    return this.getOrCreateAudioSession(track).subscribe();
  }

  private touchOnStreamStart(trackId: string): void {
    touchTrack(this.db, trackId);
    new QuotaService(this.db).touch("media", trackId, 1);
  }

  quotaPolicy() {
    return mediaQuotaPolicy(this.db);
  }

  private reconcileQuotaItems(): void {
    // One SQL upsert-seed; ready catalog size must not be materialized here.
    reconcileReadyAssetQuotaItems(this.db);
  }

  private ensureQuotaGroup(): void {
    new QuotaService(this.db).configure(this.quotaPolicy());
  }

  private accountReadyTrack(trackId: string): void {
    const bytes = readyAssetBytesForTrack(this.db, trackId);
    if (bytes > 0) {
      new QuotaService(this.db).account("media", trackId, {
        weight: bytes,
        class: "cache",
        pinUntilMs: Date.now() + ADMISSION_PIN_MS,
      });
    }
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
    const current = this.waiters.get(key) ?? [];
    if (current.length >= 16) {
      throw new MediaError("rate-limited", "等待该曲目的请求过多", true);
    }
    let waiter: ReadyWaiter;
    await new Promise<void>((resolve, reject) => {
      waiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          reject(new MediaError("timeout", "等待媒体就绪超时", true));
        }, timeoutMs),
      };
      const waiters = this.waiters.get(key) ?? [];
      waiters.push(waiter);
      this.waiters.set(key, waiters);
    })
      .catch((error) => {
        if (error instanceof MediaError && error.kind === "timeout") return;
        throw error;
      })
      .finally(() => {
        const waiters = this.waiters.get(key) ?? [];
        const remaining = waiters.filter((entry) => entry !== waiter);
        if (remaining.length) this.waiters.set(key, remaining);
        else this.waiters.delete(key);
        clearTimeout(waiter.timeout);
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

  /** Non-storage transient cleanup that still belongs to the media mechanism. */
  reconcileTransient(): void {
    deleteExpiredStreamGrants(this.db);
    reclaimExpiredQueues(this.db);
  }

  /** Owner evictor registered with the shared quota service. */
  async evictTrack(trackId: string, snapshot?: QuotaItem): Promise<boolean> {
    if (this.hasLease(trackId)) return false;
    const blobIds = this.db.transaction(() =>
      deleteAssetsIfUnreferenced(this.db, trackId),
    )();
    if (blobIds === null || blobIds.length === 0) return false;
    for (const blobId of blobIds) {
      await this.blobs.drop(blobId);
    }
    new QuotaService(this.db).release("media", trackId, snapshot);
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

async function writeProviderStream(
  stream: ProviderStream,
  outputPath: string,
): Promise<{ bytes: number; sha256: string }> {
  try {
    return await writeChunks(stream.read(), outputPath);
  } catch (error) {
    await stream.stop().catch(() => undefined);
    throw error;
  }
}

async function writeChunks(
  chunks: AsyncIterable<Uint8Array>,
  outputPath: string,
): Promise<{ bytes: number; sha256: string }> {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.from(chunks), meter, createWriteStream(outputPath));
  if (bytes === 0) {
    throw new MediaError("invalid-payload", "媒体流没有产生内容", true);
  }
  return { bytes, sha256: hash.digest("hex") };
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
