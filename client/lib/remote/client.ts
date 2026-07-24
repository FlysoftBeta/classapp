import {
  actionContracts,
  type ActionArgs,
  type ActionData,
  type ActionFunctions,
  type ActionName,
} from "@/shared/protocol/actions";
import {
  eventContracts,
  type EventData,
  type EventName,
} from "@/shared/protocol/events";
import {
  actionResultSchema,
  type CheckedActionResult,
} from "@/shared/protocol/result";
import { UncheckedError } from "@/shared/protocol/errors";
import { PROTOCOL_VERSION, serverFrameSchema } from "@/shared/protocol/wire";
import { session } from "./session";
import {
  transport,
  TransportUnavailableError,
  type TransportState,
} from "./transport";

type EventListener = (data: unknown) => void;
type ConnectionListener = (connected: boolean) => void;

export class RemoteProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "RemoteProtocolError";
  }
}

type PendingAction = {
  action: ActionName;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

/** Typed Action/Event protocol. It never starts or reconnects the transport. */
export class Client {
  readonly actions = new Proxy(
    {},
    {
      get:
        (_target, action: ActionName) =>
        (...args: unknown[]) =>
          this.call(action, ...(args as never)),
    },
  ) as ActionFunctions;

  private sequence = 0;
  private pending = new Map<string, PendingAction>();
  private eventListeners = new Map<EventName | "*", Set<EventListener>>();
  private connectionListeners = new Set<ConnectionListener>();
  private connected = false;
  buildId = "dev";

  constructor() {
    transport.onMessage((raw) => this.receive(raw));
    transport.onStateChange((state) => this.handleTransportState(state));
  }

  isConnected(): boolean {
    return transport.isConnected();
  }

  async call<K extends ActionName>(
    action: K,
    ...args: ActionArgs<K>
  ): Promise<CheckedActionResult<ActionData<K>>> {
    if (!transport.isConnected()) {
      throw new TransportUnavailableError();
    }
    const id = `${Date.now().toString(36)}-${++this.sequence}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        item.reject(new RemoteProtocolError("TIMEOUT", "请求超时"));
      }, 30_000);
      this.pending.set(id, { action, resolve, reject, timeout });
    });
    transport.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        kind: "request",
        id,
        action,
        args,
      }),
    );
    return result as Promise<CheckedActionResult<ActionData<K>>>;
  }

  subscribe<K extends EventName>(
    event: K,
    listener: (data: EventData<K>) => void,
  ): () => void {
    const stored = listener as EventListener;
    let listeners = this.eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(event, listeners);
    }
    listeners.add(stored);
    return () => {
      listeners?.delete(stored);
      if (listeners?.size === 0) this.eventListeners.delete(event);
    };
  }

  onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  private receive(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const decoded = serverFrameSchema.safeParse(json);
    if (!decoded.success) return;
    const frame = decoded.data;
    if (frame.kind === "hello") {
      this.buildId = frame.buildId;
      this.dispatch("remote.hello", { buildId: frame.buildId });
      return;
    }
    if (frame.kind === "event") {
      const contract = eventContracts[frame.event];
      const data = contract.safeParse(frame.data);
      if (data.success) this.dispatch(frame.event, data.data);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timeout);
    const contract = actionContracts[pending.action];
    const result = actionResultSchema(contract.output).safeParse(frame.result);
    if (!result.success) {
      pending.reject(
        new RemoteProtocolError(
          "INVALID_RESPONSE",
          "服务响应不符合 Action 契约",
          result.error.issues,
        ),
      );
      return;
    }
    session.observeResult(result.data);
    if (!result.data.ok && result.data.error.kind === "unchecked") {
      pending.reject(UncheckedError.fromData(result.data.error));
      return;
    }
    pending.resolve(result.data);
  }

  private dispatch<K extends EventName>(event: K, data: EventData<K>): void {
    for (const key of [event, "*"] as const) {
      for (const listener of this.eventListeners.get(key) ?? []) {
        try {
          listener(data);
        } catch {
          // Isolate listeners.
        }
      }
    }
  }

  private handleTransportState(state: TransportState): void {
    const connected = state.kind === "connected";
    if (this.connected === connected) return;
    this.connected = connected;
    for (const listener of this.connectionListeners) listener(connected);
    if (connected || this.pending.size === 0) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new RemoteProtocolError("DISCONNECTED", "服务连接已断开"));
    }
    this.pending.clear();
  }
}

export const client = new Client();
