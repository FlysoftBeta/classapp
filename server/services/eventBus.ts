/**
 * Process-local event bus for WebSocket fan-out.
 *
 * The process Runtime owns the subscriber registry. Module-level helpers are
 * retained as the domain-event API used by request Services.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { EventData, ServerEventName } from "@/shared/protocol/events";
import { eventContracts } from "@/shared/protocol/events";
import type { Database } from "better-sqlite3";
import {
  ContractViolationError,
  createIncidentService,
} from "@/server/services/incidentService";

export type BusEvent = {
  [K in ServerEventName]: {
    kind: K;
    /** Channel — see channelFor helpers. */
    channel: string;
    data: EventData<K>;
  };
}[ServerEventName];

type Subscriber = (e: BusEvent) => void;

const deferredEvents = new AsyncLocalStorage<BusEvent[]>();

/**
 * While a UnitOfWork transaction is open, `publish` records events instead of
 * delivering them. The UnitOfWork delivers the queue only after the outermost
 * commit; a rolled-back operation discards the queue with the context.
 */
export function withDeferredEvents<T>(
  operation: () => T,
  deliver: (events: BusEvent[]) => void,
): T {
  const queue: BusEvent[] = [];
  const result = deferredEvents.run(queue, operation);
  deliver(queue);
  return result;
}

function deferEvent(event: BusEvent): boolean {
  const queue = deferredEvents.getStore();
  if (!queue) return false;
  queue.push(event);
  return true;
}

export class EventBusRuntime {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(
    private readonly db: Database,
    private readonly buildId: string,
  ) {}

  subscribe(channels: string[], fn: Subscriber): () => void {
    for (const channel of channels) {
      let set = this.subscribers.get(channel);
      if (!set) {
        set = new Set();
        this.subscribers.set(channel, set);
      }
      set.add(fn);
    }
    return () => {
      for (const channel of channels) {
        const set = this.subscribers.get(channel);
        if (!set) continue;
        set.delete(fn);
        if (set.size === 0) this.subscribers.delete(channel);
      }
    };
  }

  publish<K extends ServerEventName>(
    channel: string,
    kind: K,
    data: EventData<K>,
  ): void {
    const parsed = eventContracts[kind].safeParse(data);
    if (!parsed.success) {
      throw new ContractViolationError(
        `${kind} Event payload 不符合契约`,
        parsed.error.issues,
      );
    }
    this.deliver({ kind, channel, data: parsed.data } as BusEvent);
  }

  /** Deliver an already validated event to every current subscriber. */
  deliver(evt: BusEvent): void {
    const set = this.subscribers.get(evt.channel);
    if (!set) return;
    let uncaptured: unknown = null;
    for (const fn of set) {
      try {
        fn(evt);
      } catch (error) {
        try {
          createIncidentService(this.db, this.buildId).capture({
            environment: "server",
            error,
            context: {
              component: "event-bus",
              event: evt.kind,
              channel: evt.channel,
            },
          });
        } catch (captureError) {
          console.error("[EventBus] Incident capture failed", captureError);
          console.error("[EventBus] original subscriber failure", error);
          uncaptured ??= error;
        }
      }
    }
    if (uncaptured) throw uncaptured;
  }
}

let activeRuntime: EventBusRuntime | null = null;

export function bindEventBusRuntime(runtime: EventBusRuntime): void {
  activeRuntime = runtime;
}

function runtime(): EventBusRuntime {
  if (!activeRuntime) throw new Error("EventBus Runtime is unavailable");
  return activeRuntime;
}

export function subscribe(channels: string[], fn: Subscriber): () => void {
  return runtime().subscribe(channels, fn);
}

export function publish<K extends ServerEventName>(
  channel: string,
  kind: K,
  data: EventData<K>,
): void {
  const parsed = eventContracts[kind].safeParse(data);
  if (!parsed.success) {
    throw new ContractViolationError(
      `${kind} Event payload 不符合契约`,
      parsed.error.issues,
    );
  }
  const evt = { kind, channel, data: parsed.data } as BusEvent;
  if (deferEvent(evt)) return;
  runtime().deliver(evt);
}

export function deliverDeferredEvents(events: BusEvent[]): void {
  const active = runtime();
  for (const event of events) active.deliver(event);
}

// ── Channel helpers ──────────────────────────────────────────────────────────

/** Sidebar-conversation updates for a particular user. */
export const userConvChannel = (userId: string) => `conv:${userId}`;
/** Per-group post stream. */
export const groupPostChannel = (groupId: string) => `post:group:${groupId}`;
/** DM stream between two users. Order-independent. */
export const dmPostChannel = (a: string, b: string) =>
  `post:dm:${[a, b].sort().join(":")}`;
/** Client-level state changes (konami lock, etc.). */
export const clientChannel = (clientId: string) => `client:${clientId}`;
/** User-level state changes (ban, mute, etc.). */
export const userChannel = (userId: string) => `user:${userId}`;
/** System-wide config changes. */
export const systemChannel = () => "system";

// ── Convenience wrappers ─────────────────────────────────────────────────────

export function publishClient<K extends ServerEventName>(
  clientId: string,
  evt: { kind: K; data: EventData<K> },
) {
  publish(clientChannel(clientId), evt.kind, evt.data);
}

export function publishUser<K extends ServerEventName>(
  userId: string,
  evt: { kind: K; data: EventData<K> },
) {
  publish(userChannel(userId), evt.kind, evt.data);
}

export function publishSystem<K extends ServerEventName>(evt: {
  kind: K;
  data: EventData<K>;
}) {
  publish(systemChannel(), evt.kind, evt.data);
}

export function publishGroupPost<K extends ServerEventName>(
  groupId: string,
  evt: { kind: K; data: EventData<K> },
) {
  publish(groupPostChannel(groupId), evt.kind, evt.data);
}

export function publishDmPost<K extends ServerEventName>(
  a: string,
  b: string,
  evt: { kind: K; data: EventData<K> },
) {
  publish(dmPostChannel(a, b), evt.kind, evt.data);
}

export function publishUserConv(
  userId: string,
  evt: { kind: "conv.updated"; data: EventData<"conv.updated"> } = {
    kind: "conv.updated",
    data: { refresh: true },
  },
) {
  publish(userConvChannel(userId), evt.kind, evt.data);
}

/** Article events scoped to a group (list invalidation). */
export const groupArticleChannel = (groupId: string) =>
  `article:group:${groupId}`;

export function publishGroupArticle<K extends ServerEventName>(
  groupId: string,
  evt: { kind: K; data: EventData<K> },
) {
  publish(groupArticleChannel(groupId), evt.kind, evt.data);
}

/** Ask the client to refresh its WebSocket channel subscriptions. */
export function publishRemoteResubscribe(userId: string, reason: string): void {
  publishUser(userId, { kind: "remote.resubscribe", data: { reason } });
}
