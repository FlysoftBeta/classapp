/**
 * Process-local event bus for WebSocket fan-out.
 *
 * Subscribers live on globalThis so dynamically loaded service chunks share
 * one bus with the WebSocket protocol runtime.
 */

import type { EventData, ServerEventName } from "@/shared/protocol/events";
import { eventContracts } from "@/shared/protocol/events";
import { UncheckedError } from "@/shared/protocol/errors";

export type BusEvent = {
  [K in ServerEventName]: {
    kind: K;
    /** Channel — see channelFor helpers. */
    channel: string;
    data: EventData<K>;
  };
}[ServerEventName];

type Subscriber = (e: BusEvent) => void;

declare global {
  var __classappEventBus: Map<string, Set<Subscriber>> | undefined;
}

function subscribers(): Map<string, Set<Subscriber>> {
  if (!globalThis.__classappEventBus) {
    globalThis.__classappEventBus = new Map();
  }
  return globalThis.__classappEventBus;
}

export function subscribe(channels: string[], fn: Subscriber): () => void {
  const subs = subscribers();
  for (const ch of channels) {
    let set = subs.get(ch);
    if (!set) {
      set = new Set();
      subs.set(ch, set);
    }
    set.add(fn);
  }
  return () => {
    for (const ch of channels) {
      const set = subs.get(ch);
      if (!set) continue;
      set.delete(fn);
      if (set.size === 0) subs.delete(ch);
    }
  };
}

export function publish<K extends ServerEventName>(
  channel: string,
  kind: K,
  data: EventData<K>,
): void {
  const parsed = eventContracts[kind].safeParse(data);
  if (!parsed.success) {
    console.error(`[EventBus] ${kind} payload 不符合契约`, parsed.error.issues);
    throw UncheckedError.internal("Event payload 不符合契约");
  }
  const set = subscribers().get(channel);
  if (!set) return;
  const evt = { kind, channel, data: parsed.data } as BusEvent;
  for (const fn of set) {
    try {
      fn(evt);
    } catch {
      /* never let one bad subscriber kill the bus */
    }
  }
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
