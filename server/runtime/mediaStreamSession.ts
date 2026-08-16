import { MediaError, type ProviderStream } from "@/lib/media";

/**
 * One yt-dlp audio stream can feed several HTTP relays and the background
 * materialization job at once.
 *
 * Relay consumers get a bounded queue: if a client stalls and falls more than
 * 64 MiB behind, it is dropped rather than letting a paused tab block the
 * shared stream forever. The materialization consumer is not droppable;
 * instead the pump stops pulling from the provider while materialization is
 * above its high-water mark, so disk backpressure bounds memory.
 */
const RELAY_BUFFER_LIMIT = 64 * 1024 * 1024;
const MATERIALIZATION_HIGH_WATER = 8 * 1024 * 1024;

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
  droppable: boolean;
  maxBufferBytes: number;
  drainWaiters: Array<() => void>;
}

export interface StreamSubscription {
  read(): AsyncIterable<Uint8Array>;
  release(): void;
}

interface SubscribeOptions {
  /** Slow subscribers are dropped when their queue exceeds maxBufferBytes. */
  droppable: boolean;
  maxBufferBytes: number;
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

  subscribe(options: SubscribeOptions): StreamSubscription {
    const sub: StreamSubscriber = {
      queue: [],
      queueBytes: 0,
      done: false,
      error: null,
      released: false,
      pending: null,
      droppable: options.droppable,
      maxBufferBytes: options.maxBufferBytes,
      drainWaiters: [],
    };
    if (this.sourceEnded) {
      sub.done = this.sourceError === null;
      sub.error = this.sourceError;
    } else {
      this.subscribers.add(sub);
    }
    return {
      read: () => readSubscriber(sub, () => this.chunkConsumed(sub)),
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
    this.resolveDrainWaiters(sub);
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
        await this.waitForRequiredDrain();
      }
      this.finish(null);
    } catch (error) {
      this.finish(error);
    }
  }

  private broadcast(chunk: Uint8Array): void {
    for (const sub of [...this.subscribers]) {
      if (sub.released) continue;
      if (
        sub.droppable &&
        sub.queueBytes + chunk.byteLength > sub.maxBufferBytes
      ) {
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

  private async waitForRequiredDrain(): Promise<void> {
    for (const sub of [...this.subscribers]) {
      if (sub.released || sub.droppable) continue;
      while (sub.queueBytes > sub.maxBufferBytes && !sub.released) {
        await new Promise<void>((resolve) => {
          sub.drainWaiters.push(resolve);
        });
      }
    }
  }

  private chunkConsumed(sub: StreamSubscriber): void {
    if (sub.queueBytes <= sub.maxBufferBytes) {
      this.resolveDrainWaiters(sub);
    }
  }

  private resolveDrainWaiters(sub: StreamSubscriber): void {
    const waiters = sub.drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private drop(sub: StreamSubscriber, error: MediaError): void {
    sub.released = true;
    sub.error = error;
    this.subscribers.delete(sub);
    const pending = sub.pending;
    sub.pending = null;
    if (pending) pending.reject(error);
    this.resolveDrainWaiters(sub);
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
      this.resolveDrainWaiters(sub);
    }
  }
}

async function* readSubscriber(
  sub: StreamSubscriber,
  onChunkConsumed: () => void,
): AsyncIterable<Uint8Array> {
  while (true) {
    if (sub.queue.length > 0) {
      const chunk = sub.queue.shift()!;
      sub.queueBytes -= chunk.byteLength;
      onChunkConsumed();
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
    const subscription = this.fanout.subscribe({
      droppable: true,
      maxBufferBytes: RELAY_BUFFER_LIMIT,
    });
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
    try {
      if (!this.deps.findReady()) {
        this.materializationSettled = false;
        this.materializationSub = this.fanout.subscribe({
          droppable: false,
          maxBufferBytes: MATERIALIZATION_HIGH_WATER,
        });
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
