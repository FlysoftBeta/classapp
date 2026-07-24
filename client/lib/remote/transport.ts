export type TransportState =
  | { kind: "stopped" }
  | { kind: "connecting"; socket: WebSocket }
  | { kind: "connected"; socket: WebSocket }
  | { kind: "cooldown"; retryAt: number }
  | { kind: "offline" };

type StateListener = (state: TransportState) => void;
type MessageListener = (raw: string) => void;

const CONNECT_TIMEOUT_MS = 5_000;
const COOLDOWN_MS = 10_000;

export class TransportUnavailableError extends Error {
  constructor(message = "服务连接不可用") {
    super(message);
    this.name = "TransportUnavailableError";
  }
}

/** Owns the WebSocket lifecycle. No protocol, authentication, or RPC logic. */
export class WebSocketTransport {
  private state: TransportState = { kind: "stopped" };
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private stateListeners = new Set<StateListener>();
  private messageListeners = new Set<MessageListener>();

  getState(): TransportState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state.kind === "connected";
  }

  isForcedOffline(): boolean {
    return this.state.kind === "offline";
  }

  start(): void {
    if (this.state.kind !== "stopped") return;
    this.open();
  }

  stop(): void {
    this.clearTimers();
    this.closeCurrentSocket();
    this.transition({ kind: "stopped" });
  }

  setForcedOffline(offline: boolean): void {
    if (offline) {
      if (this.state.kind === "offline") return;
      this.clearTimers();
      this.closeCurrentSocket();
      this.transition({ kind: "offline" });
      return;
    }
    if (this.state.kind !== "offline") return;
    this.transition({ kind: "stopped" });
    this.start();
  }

  send(raw: string): void {
    if (this.state.kind !== "connected") {
      throw new TransportUnavailableError();
    }
    this.state.socket.send(raw);
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  private open(): void {
    if (this.state.kind !== "stopped") return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.transition({ kind: "connecting", socket });

    this.connectTimeout = setTimeout(() => {
      if (!this.owns(socket, "connecting")) return;
      socket.close();
      this.enterCooldown();
    }, CONNECT_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      if (!this.owns(socket, "connecting")) return;
      this.clearConnectTimeout();
      this.transition({ kind: "connected", socket });
    });
    socket.addEventListener("message", (event) => {
      if (!this.owns(socket, "connected")) return;
      for (const listener of this.messageListeners) {
        listener(String(event.data));
      }
    });
    socket.addEventListener("close", () => {
      if (!this.owns(socket)) return;
      this.clearConnectTimeout();
      this.enterCooldown();
    });
    socket.addEventListener("error", () => socket.close());
  }

  private enterCooldown(): void {
    if (this.state.kind === "offline" || this.state.kind === "stopped") return;
    const retryAt = Date.now() + COOLDOWN_MS;
    this.transition({ kind: "cooldown", retryAt });
    this.cooldownTimer = setTimeout(() => {
      if (this.state.kind !== "cooldown") return;
      this.cooldownTimer = null;
      this.transition({ kind: "stopped" });
      this.open();
    }, COOLDOWN_MS);
  }

  private owns(socket: WebSocket, kind?: "connecting" | "connected"): boolean {
    const state = this.state;
    if (state.kind !== "connecting" && state.kind !== "connected") return false;
    return state.socket === socket && (!kind || state.kind === kind);
  }

  private closeCurrentSocket(): void {
    const state = this.state;
    if (state.kind === "connecting" || state.kind === "connected") {
      state.socket.close();
    }
  }

  private clearConnectTimeout(): void {
    if (!this.connectTimeout) return;
    clearTimeout(this.connectTimeout);
    this.connectTimeout = null;
  }

  private clearTimers(): void {
    this.clearConnectTimeout();
    if (!this.cooldownTimer) return;
    clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
  }

  private transition(state: TransportState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

export const transport = new WebSocketTransport();
