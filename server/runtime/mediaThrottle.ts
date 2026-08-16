import { MediaError } from "@/lib/media";

/**
 * Provider-process pacing owned by MediaRuntime. lib/media only parses and
 * streams; how many yt-dlp processes may start and how close together is a
 * server-side runtime policy.
 */
export class LayerThrottle {
  private pending = 0;
  private inFlight = false;
  private lastStartedAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly intervalMs: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      const waitMs = Math.max(
        0,
        this.lastStartedAt + this.intervalMs - Date.now(),
      );
      if (waitMs > 0) await delay(waitMs);
      this.inFlight = true;
      this.lastStartedAt = Date.now();
      return await operation();
    } finally {
      this.inFlight = false;
      this.pending -= 1;
      release();
    }
  }

  get busy(): boolean {
    return this.inFlight || this.pending > 0;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounds how many provider-backed streams may run at once. Callers hold the
 * returned release function for the whole stream lifetime; waiters queue for a
 * bounded time and then fail with a retryable rate-limit error.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];

  constructor(
    readonly max: number,
    readonly waitMs: number,
  ) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new MediaError("cancelled", "媒体流已取消"));
    }
    if (this.active < this.max) {
      return Promise.resolve(this.grant());
    }
    return new Promise<() => void>((resolve, reject) => {
      const state: {
        settled: boolean;
        timer: ReturnType<typeof setTimeout> | null;
      } = { settled: false, timer: null };
      const waiter = {
        resolve: () => {
          if (state.settled) return;
          state.settled = true;
          if (state.timer) clearTimeout(state.timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(this.grant());
        },
        reject: (error: unknown) => {
          if (state.settled) return;
          state.settled = true;
          if (state.timer) clearTimeout(state.timer);
          signal?.removeEventListener("abort", onAbort);
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(error);
        },
      };
      const onAbort = () =>
        waiter.reject(new MediaError("cancelled", "媒体流已取消"));
      state.timer = setTimeout(() => {
        waiter.reject(
          new MediaError("rate-limited", "媒体流并发已满，请稍后重试", true),
        );
      }, this.waitMs);
      state.timer.unref?.();
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private grant(): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      next?.resolve();
    };
  }
}
