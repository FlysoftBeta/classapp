export interface CooldownAllocation {
  retryAt: number;
  retryAfterMs: number;
  interference: number;
}

interface UserCooldownState {
  assignedAt: number;
  retryAt: number;
  interference: number;
  lastBusyAt: number;
}

/**
 * Assigns soft retry windows without charging users for successful use.
 * Only retrying before an already assigned window increases interference.
 */
export class DynamicCooldownAllocator {
  private readonly users = new Map<string, UserCooldownState>();

  constructor(
    private readonly slotMs = 5_000,
    private readonly stateTtlMs = 5 * 60_000,
  ) {}

  allocate(
    userId: string,
    resourceReadyAt: number,
    now = Date.now(),
  ): CooldownAllocation {
    this.prune(now);
    const previous = this.users.get(userId);
    const retriedEarly = previous !== undefined && now < previous.retryAt;
    const interference = retriedEarly
      ? previous.interference + 1
      : Math.max(0, (previous?.interference ?? 0) - 1);

    const occupied = new Set(
      [...this.users.entries()]
        .filter(([id, state]) => id !== userId && state.retryAt >= now)
        .map(([, state]) => state.retryAt),
    );
    let retryAt = Math.max(now, resourceReadyAt);
    // Premature retries move behind well-behaved contenders. A missed soft
    // reservation never prevents an actually idle client from being used.
    retryAt += interference * this.slotMs;
    while (occupied.has(retryAt)) retryAt += this.slotMs;

    this.users.set(userId, {
      assignedAt: now,
      retryAt,
      interference,
      lastBusyAt: now,
    });
    return {
      retryAt,
      retryAfterMs: Math.max(0, retryAt - now),
      interference,
    };
  }

  succeeded(userId: string): void {
    this.users.delete(userId);
  }

  private prune(now: number): void {
    for (const [userId, state] of this.users) {
      if (
        now - Math.max(state.lastBusyAt, state.assignedAt) >
        this.stateTtlMs
      ) {
        this.users.delete(userId);
      }
    }
  }
}
