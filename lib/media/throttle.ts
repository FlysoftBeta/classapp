/**
 * Per-layer operation throttle, borrowed from lib/tomato's Client cooldown
 * model. All jobs share one provider backend, so fairness means a FIFO tail
 * plus a minimum interval between process starts.
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

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
