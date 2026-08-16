/**
 * Provider-facing media facts. Raw yt-dlp JSON never leaves the provider
 * layer; provider-specific locators such as thumbnail URLs are carried as
 * hidden track hints (see track.ts) and never appear on this public type.
 */
export interface ProviderTrack {
  readonly source: string;
  readonly providerId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly album: string | null;
  readonly durationMs: number;
}

export type MediaProgressFn = (percent: number | null) => void;

export interface StreamOptions {
  signal: AbortSignal;
  onProgress?: MediaProgressFn;
}

/**
 * A live provider byte stream. The provider only resolves bytes; callers own
 * destinations, storage, leases, and backfill decisions.
 */
export interface ProviderStream {
  /** MIME type of the resolved bytes, e.g. audio/webm or image/jpeg. */
  readonly contentType: string;
  /**
   * One-shot async iteration over streamed chunks. Rejects with a MediaError
   * when the provider fails, times out, or the stream is cancelled.
   */
  read(): AsyncIterable<Uint8Array>;
  /** Idempotently tear down the underlying provider process/request. */
  stop(): Promise<void>;
}

/**
 * Stream-only provider contract. Search is the only non-stream operation and
 * returns tracks that already carry the metadata callers need; no download or
 * metadata-refetch operation belongs here.
 */
export interface MediaProvider {
  readonly source: string;
  search(
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<ProviderTrack[]>;
  streamTrack(
    track: ProviderTrack,
    options: StreamOptions,
  ): Promise<ProviderStream>;
  streamCover(
    track: ProviderTrack,
    options: StreamOptions,
  ): Promise<ProviderStream>;
}
