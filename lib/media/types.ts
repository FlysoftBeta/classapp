/** Normalized provider facts. No yt-dlp JSON leaves the provider layer. */
export interface ProviderTrack {
  source: string;
  providerId: string;
  canonicalUrl: string;
  title: string;
  artists: string[];
  album: string | null;
  durationMs: number;
  thumbnailUrl: string | null;
}

export interface MaterializedAsset {
  path: string;
  mime: string;
  bytes: number;
  sha256: string;
}

export type MediaProgressFn = (percent: number | null) => void;

export interface LiveStreamHandle {
  /** Buffers appended by the yt-dlp stdout stream. */
  read(): AsyncIterable<Uint8Array>;
  stop(): Promise<void>;
}

export interface MediaProvider {
  readonly source: string;
  search(query: string, limit: number, signal: AbortSignal): Promise<ProviderTrack[]>;
  download(
    track: ProviderTrack,
    outputPath: string,
    onProgress: MediaProgressFn,
    signal: AbortSignal,
  ): Promise<MaterializedAsset>;
  downloadCover(
    track: ProviderTrack,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<MaterializedAsset>;
  openLiveStream(
    track: ProviderTrack,
    onProgress: MediaProgressFn,
    signal: AbortSignal,
  ): Promise<LiveStreamHandle>;
}
