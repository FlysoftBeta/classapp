import { Client, TomatoClient } from "./client";
import { ClientBusyError } from "./errors";
import { DynamicCooldownAllocator } from "./quota";
import type { ClientOptions, CooldownLayer } from "./types";

interface Slot<T extends Client> {
  client: T;
  leased: Set<CooldownLayer>;
}

export class ClientPool<T extends Client> {
  private readonly allocator = new DynamicCooldownAllocator();

  constructor(private readonly slots: Slot<T>[]) {
    if (slots.length === 0) throw new Error("ClientPool 至少需要一个 Client");
  }

  async runInteractive<R>(
    userId: string,
    layer: CooldownLayer,
    operation: (client: T) => Promise<R>,
  ): Promise<R> {
    const now = Date.now();
    const slot = this.slots.find(
      (candidate) =>
        !candidate.leased.has(layer) &&
        candidate.client.availableAt(layer) <= now,
    );
    if (!slot) {
      const resourceReadyAt = Math.min(
        ...this.slots.map((candidate) =>
          candidate.leased.has(layer)
            ? now + candidate.client.cooldownMs(layer)
            : candidate.client.availableAt(layer),
        ),
      );
      const allocation = this.allocator.allocate(userId, resourceReadyAt, now);
      throw new ClientBusyError(allocation.retryAfterMs, allocation.retryAt);
    }
    slot.leased.add(layer);
    try {
      const result = await operation(slot.client);
      this.allocator.succeeded(userId);
      return result;
    } finally {
      slot.leased.delete(layer);
    }
  }

  async runQueued<R>(
    layer: CooldownLayer,
    operation: (client: T) => Promise<R>,
  ): Promise<R> {
    for (;;) {
      const now = Date.now();
      const slot = this.slots.find(
        (candidate) =>
          !candidate.leased.has(layer) &&
          candidate.client.availableAt(layer) <= now,
      );
      if (slot) {
        slot.leased.add(layer);
        try {
          return await operation(slot.client);
        } finally {
          slot.leased.delete(layer);
        }
      }
      const next = Math.min(
        ...this.slots
          .filter((candidate) => !candidate.leased.has(layer))
          .map((candidate) => candidate.client.availableAt(layer)),
      );
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Number.isFinite(next) ? Math.min(100, Math.max(25, next - now)) : 100,
        ),
      );
    }
  }
}

export function createTomatoClientPool(
  size = 2,
  options: ClientOptions = {},
): ClientPool<TomatoClient> {
  return new ClientPool(
    Array.from({ length: Math.max(1, Math.floor(size)) }, () => ({
      client: new TomatoClient(options),
      leased: new Set<CooldownLayer>(),
    })),
  );
}
