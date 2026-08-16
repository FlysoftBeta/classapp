import { MediaError, type ProviderStream } from "@/lib/media";

/**
 * One yt-dlp audio stream can feed several HTTP relays and the background
 * materialization job at once. Each consumer gets its own bounded queue so a
 * slow client can never stall the shared provider or the other listeners; if a
 * consumer falls more than ~8 MiB behind, it is dropped instead of growing
 * without limit.
 */
const MAX_SUBSCRIBER_BUFFER_BYTES = 8 * 1024 * 1024;

interface PendingNext {
  resolve(): void;
  reject(error: unknown): void;
}

interface StreamSubscriber {
  queue: Uint8Array[];
  queueBytes: number;
  done: boolean;
  error: unknown;
  released: boolean;
  pending: PendingNext | null;
}

export interface StreamSubscription {
  read(): AsyncIterable<Uint8Array>;
  release(): void;
}

class ChunkFanout {
  private source: AsyncIterable<Uint8Array> | null = null;
  private readonly subscribers = new Set<StreamSubscriber>();
  private sourceEnded = false;
  private sourceError: unknown = null;
  private pumpPromise: Promise<void> | null = null;

  get ended(): boolean {
    return this.sourceEnded;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  subscribe(): StreamSubscription {
    const sub: StreamSubscriber = {
      queue: [],
      queueBytes: 0,
      done: false,
      error: null,
      released: false,
      pending: null,
    };
    if (this.sourceEnded) {
      sub.done = this.sourceError === null;
      sub.error = this.sourceError;
    } else {
      this.subscribers.add(sub);
    }
    return {
      read: () => readSubscriber(sub),
      release: () => this.release(sub),
    };
  }

  release(sub: StreamSubscriber): void {
    if (sub.released) return;
    sub.released = true;
    this.subscribers.delete(sub);
    const pending = sub.pending;
    sub.pending = null;
    const cancelled = new MediaError("cancelled", "媒体流已取消");
    if (pending) pending.reject(cancelled);
    else sub.error = cancelled;
  }

  /** Start consuming the source. Subscribers added after this still share it. */
  attach(source: AsyncIterable<Uint8Array>): Promise<void> {
    if (this.pumpPromise) return this.pumpPromise;
    this.source = source;
    this.pumpPromise = this.pump();
    return this.pumpPromise;
  }

  /** Reject every subscriber before a source was ever attached. */
  fail(error: unknown): void {
    this.finish(error);
  }

  private async pump(): Promise<void> {
    try {
      for await (const chunk of this.source!) {
        this.broadcast(chunk);
      }
      this.finish(null);
    } catch (error) {
      this.finish(error);
    }
  }

  private broadcast(chunk: Uint8Array): void {
    for (const sub of [...this.subscribers]) {
      if (sub.released) continue;
      if (sub.queueBytes + chunk.byteLength > MAX_SUBSCRIBER_BUFFER_BYTES) {
        this.drop(
          sub,
          new MediaError("rate-limited", "媒体流消费者读取过慢", true),
        );
        continue;
      }
      sub.queue.push(chunk);
      sub.queueBytes += chunk.byteLength;
      const pending = sub.pending;
      sub.pending = null;
      pending?.resolve();
    }
  }

  private drop(sub: StreamSubscriber, error: MediaError): void {
    sub.released = true;
    sub.error = error;
    this.subscribers.delete(sub);
    const pending = sub.pending;
    sub.pending = null;
    if (pending) pending.reject(error);
  }

  private finish(error: unknown): void {
    if (this.sourceEnded) return;
    this.sourceEnded = true;
    this.sourceError = error ?? null;
    for (const sub of [...this.subscribers]) {
      if (sub.released) continue;
      if (error) sub.error = error;
      else sub.done = true;
      const pending = sub.pending;
      sub.pending = null;
      if (pending) {
        if (error) pending.reject(error);
        else pending.resolve();
      }
    }
  }
}

async function* readSubscriber(
  sub: StreamSubscriber,
): AsyncIterable<Uint8Array> {
  while (true) {
    if (sub.queue.length > 0) {
      const chunk = sub.queue.shift()!;
      sub.queueBytes -= chunk.byteLength;
      yield chunk;
      continue;
    }
    if (sub.error) throw sub.error;
    if (sub.done) return;
    await new Promise<void>((resolve, reject) => {
      sub.pending = { resolve, reject };
    });
  }
}

export interface AudioStreamSessionDeps {
  /** Synchronous check for an already-ready audio asset. */
  findReady(): boolean;
  /** Start the provider stream; the release callback frees the concurrency slot. */
  startProvider(
    signal: AbortSignal,
  ): Promise<{ stream: ProviderStream; release(): void }>;
  /** Consume one fanout subscription into the shared object store. */
  materializeFrom(subscription: StreamSubscription): Promise<void>;
  /** Session is done; remove it from the owning map. */
  onDispose(session: AudioStreamSession): void;
}

/**
 * One provider stream per track. Relays subscribe for playback while a
 * materialization subscription (when the asset is not ready yet) writes the
 * same bytes into object storage. The session lives until the source ended and
 * the materialization settled, or until the last relay goes away without a
 * materialization to keep it alive.
 */
export class AudioStreamSession {
  private readonly fanout = new ChunkFanout();
  private readonly abort = new AbortController();
  private provider: ProviderStream | null = null;
  private releaseProviderSlot: (() => void) | null = null;
  private materializationSub: StreamSubscription | null = null;
  private materializationPromise: Promise<void> | null = null;
  private materializationSettled = true;
  private sourceEnded = false;
  private disposed = false;

  constructor(private readonly deps: AudioStreamSessionDeps) {
    void this.start();
  }

  get materialization(): Promise<void> | null {
    return this.materializationPromise;
  }

  /** Join this stream for live relay playback. */
  subscribe(): ProviderStream {
    const subscription = this.fanout.subscribe();
    let released = false;
    return {
      contentType: "audio/webm",
      read: () => subscription.read(),
      stop: async () => {
        if (released) return;
        released = true;
        subscription.release();
        this.maybeDispose();
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.releaseProviderSlot?.();
    this.releaseProviderSlot = null;
    void this.provider?.stop().catch(() => undefined);
    this.deps.onDispose(this);
  }

  private async start(): Promise<void> {
    if (!this.deps.findReady()) {
      this.materializationSettled = false;
      this.materializationSub = this.fanout.subscribe();
      this.materializationPromise = this.deps
        .materializeFrom(this.materializationSub)
        .catch(() => undefined)
        .finally(() => {
          this.materializationSettled = true;
          this.materializationSub?.release();
          this.materializationSub = null;
          this.maybeDispose();
        });
    }

    try {
      const started = await this.deps.startProvider(this.abort.signal);
      if (this.disposed) {
        started.release();
        await started.stream.stop().catch(() => undefined);
        return;
      }
      this.provider = started.stream;
      this.releaseProviderSlot = started.release;
      void this.fanout.attach(started.stream.read()).then(() => {
        this.sourceEnded = true;
        this.maybeDispose();
      });
    } catch (error) {
      this.sourceEnded = true;
      this.materializationSettled = true;
      this.fanout.fail(error);
      this.maybeDispose();
    }
  }

  private maybeDispose(): void {
    if (this.disposed) return;
    if (this.sourceEnded && this.materializationSettled) {
      this.dispose();
      return;
    }
    if (!this.materializationSub && this.fanout.subscriberCount === 0) {
      this.dispose();
    }
  }
}
