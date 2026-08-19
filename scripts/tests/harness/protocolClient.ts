import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  authenticatedFrameSchema,
  helloFrameSchema,
  serverFrameSchema,
  type EventFrame,
  type HelloFrame,
} from "@/shared/protocol/wire";
import type { ActionArgs, ActionData, ActionName } from "@/shared/protocol/actions";
import type { ActionResult } from "@/shared/protocol/result";

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly incidentId?: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

type Pending = {
  resolve: (result: ActionResult<unknown>) => void;
  reject: (error: Error) => void;
};

/**
 * Thin WebSocket protocol client. It speaks frames only and does not use the
 * application client, Interact layer, or IndexedDB.
 */
export class ProtocolClient {
  private socket: WebSocket | null = null;
  private hello: HelloFrame | null = null;
  private requestCount = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly authentications = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  readonly events: EventFrame[] = [];

  constructor(private readonly url: string) {}

  async connect(timeoutMs = 10_000): Promise<HelloFrame> {
    if (this.socket) throw new Error("Protocol client already connected");
    const socket = new WebSocket(this.url);
    this.socket = socket;
    const hello = await new Promise<HelloFrame>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for protocol hello")),
        timeoutMs,
      );
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("message", (bytes) => {
        clearTimeout(timer);
        try {
          resolve(helloFrameSchema.parse(JSON.parse(bytes.toString())));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    this.hello = hello;
    socket.on("message", (bytes) => this.onMessage(bytes.toString()));
    socket.on("close", () => {
      const closed = new Error("WebSocket closed");
      for (const waiter of this.pending.values()) waiter.reject(closed);
      this.pending.clear();
      for (const waiter of this.authentications.values()) waiter.reject(closed);
      this.authentications.clear();
    });
    return hello;
  }

  get buildId(): string {
    if (!this.hello) throw new Error("Protocol client is not connected");
    return this.hello.buildId;
  }

  async authenticate(userId: string, token: string): Promise<void> {
    const socket = this.requireOpen();
    await new Promise<void>((resolve, reject) => {
      this.authentications.set(userId, { resolve, reject });
      socket.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          kind: "authenticate",
          user: userId,
          token,
        }),
      );
    });
  }

  async request<K extends ActionName>(
    action: K,
    args: ActionArgs<K>,
    user: string | null,
    timeoutMs = 20_000,
  ): Promise<ActionData<K>> {
    const result = await this.requestRaw(action, args, user, timeoutMs);
    if (!result.ok) {
      throw new ProtocolError(result.error.message, result.error.incidentId);
    }
    return result.data as ActionData<K>;
  }

  async requestRaw(
    action: string,
    args: unknown[],
    user: string | null,
    timeoutMs = 20_000,
  ): Promise<ActionResult<unknown>> {
    const socket = this.requireOpen();
    this.requestCount += 1;
    const id = `t${this.requestCount}-${randomUUID().slice(0, 8)}`;
    return await new Promise<ActionResult<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${action}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          kind: "request",
          id,
          user,
          action,
          args,
        }),
      );
    });
  }

  async sendRaw(frame: unknown): Promise<void> {
    this.requireOpen().send(JSON.stringify(frame));
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  }

  private requireOpen(): WebSocket {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Protocol client is not connected");
    }
    return socket;
  }

  private onMessage(text: string): void {
    const parsed = serverFrameSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.kind === "response") {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      waiter.resolve(frame.result as ActionResult<unknown>);
      return;
    }
    if (frame.kind === "authenticated") {
      const authenticated = authenticatedFrameSchema.parse(frame);
      const waiter = this.authentications.get(authenticated.user);
      if (!waiter) return;
      this.authentications.delete(authenticated.user);
      if (authenticated.result.ok) waiter.resolve();
      else {
        waiter.reject(
          new ProtocolError(
            authenticated.result.error.message,
            authenticated.result.error.incidentId,
          ),
        );
      }
      return;
    }
    if (frame.kind === "event") this.events.push(frame);
  }
}
