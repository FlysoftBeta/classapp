import type { ObjectRef } from "./paths";

export interface KeyedLock {
  run<T>(ref: ObjectRef, operation: () => Promise<T> | T): Promise<T>;
}

/**
 * Per-object async mutex. It is deliberately instance-scoped so every store
 * owns its lock map and no hidden process-global survives construction.
 */
export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<void>>();

  async function run<T>(
    ref: ObjectRef,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const key = `${ref.namespace}\u0000${ref.key}`;
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    tails.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === queued) tails.delete(key);
    }
  }

  return { run };
}
