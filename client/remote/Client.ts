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
};

/** Aggregates typed Actions and Events over the stateful WebSocket protocol. */
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

  private socket: WebSocket | null = null;
  private token = "";
  private sequence = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 500;
  private pending = new Map<string, PendingAction>();
  private eventListeners = new Map<EventName | "*", Set<EventListener>>();
  private connectionListeners = new Set<ConnectionListener>();
  buildId = "dev";
  private connected = false;
  private forcedOffline = false;

  isConnected(): boolean {
    return this.connected && !this.forcedOffline;
  }

  isForcedOffline(): boolean {
    return this.forcedOffline;
  }

  setForcedOffline(forcedOffline: boolean): void {
    if (this.forcedOffline === forcedOffline) return;
    const wasConnected = this.isConnected();
    this.forcedOffline = forcedOffline;

    if (forcedOffline) {
      for (const pending of this.pending.values()) {
        pending.reject(
          new RemoteProtocolError("OFFLINE", "已强制切换到离线模式"),
        );
      }
      this.pending.clear();
    }

    if (!forcedOffline && this.connected) this.authenticate();
    const isConnected = this.isConnected();
    if (wasConnected !== isConnected) this.notifyConnection(isConnected);
    if (!forcedOffline && !this.connected) this.connect();
  }

  connect(): void {
    if (this.forcedOffline) return;
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectDelay = 500;
      this.authenticate();
      this.setTransportConnected(true);
    });
    socket.addEventListener("message", (event) =>
      this.receive(String(event.data)),
    );
    socket.addEventListener("close", () => this.disconnected());
    socket.addEventListener("error", () => socket.close());
  }

  /** Authentication is connection state; Action frames never repeat the token. */
  setToken(token: string): void {
    this.token = token;
    this.authenticate();
  }

  async call<K extends ActionName>(
    action: K,
    ...args: ActionArgs<K>
  ): Promise<CheckedActionResult<ActionData<K>>> {
    await this.ready();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new RemoteProtocolError("OFFLINE", "服务连接不可用");
    }
    const id = `${Date.now().toString(36)}-${++this.sequence}`;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { action, resolve, reject });
      setTimeout(() => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        item.reject(new RemoteProtocolError("TIMEOUT", "请求超时"));
      }, 30_000);
    });
    socket.send(
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

  private async ready(): Promise<void> {
    if (this.forcedOffline) {
      throw new RemoteProtocolError("OFFLINE", "已强制切换到离线模式");
    }
    this.connect();
    if (this.socket?.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        off();
        reject(new RemoteProtocolError("OFFLINE", "无法连接服务"));
      }, 10_000);
      const off = this.onConnectionChange((connected) => {
        if (!connected) return;
        clearTimeout(timeout);
        off();
        resolve();
      });
    });
  }

  private authenticate(): void {
    if (this.forcedOffline) return;
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        kind: "authenticate",
        token: this.token,
      }),
    );
  }

  private receive(raw: string): void {
    if (this.forcedOffline) return;
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

  private disconnected(): void {
    this.socket = null;
    for (const pending of this.pending.values()) {
      pending.reject(new RemoteProtocolError("DISCONNECTED", "服务连接已断开"));
    }
    this.pending.clear();
    this.setTransportConnected(false);
    if (this.forcedOffline || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
  }

  private setTransportConnected(connected: boolean): void {
    const wasConnected = this.isConnected();
    this.connected = connected;
    const isConnected = this.isConnected();
    if (wasConnected === isConnected) return;
    this.notifyConnection(isConnected);
  }

  private notifyConnection(connected: boolean): void {
    for (const listener of this.connectionListeners) listener(connected);
  }
}

export const client = new Client();
