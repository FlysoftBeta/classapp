import type { ActionResult } from "@/shared/protocol/result";
import { PROTOCOL_VERSION } from "@/shared/protocol/wire";
import { transport, type TransportState } from "./transport";

type InvalidHandler = () => void;

class RemoteSession {
  private token = "";
  private invalidHandler: InvalidHandler | null = null;

  constructor() {
    transport.onStateChange((state) => this.handleTransportState(state));
  }

  getToken(): string {
    return this.token;
  }

  setToken(token: string): void {
    if (this.token === token) return;
    this.token = token;
    this.authenticate();
  }

  setInvalidHandler(handler: InvalidHandler | null): void {
    this.invalidHandler = handler;
  }

  invalidate(): void {
    this.setToken("");
    this.invalidHandler?.();
  }

  observeResult<T>(result: ActionResult<T>): void {
    if (
      !result.ok &&
      result.error.kind === "checked" &&
      result.error.tokenExpired
    ) {
      this.invalidate();
    }
  }

  private handleTransportState(state: TransportState): void {
    if (state.kind === "connected") this.authenticate();
  }

  private authenticate(): void {
    if (!transport.isConnected()) return;
    transport.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        kind: "authenticate",
        token: this.token,
      }),
    );
  }
}

export const session = new RemoteSession();
