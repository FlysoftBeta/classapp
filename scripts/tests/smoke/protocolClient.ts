import WebSocket from "ws";
import {
  actionContracts,
  type ActionArgs,
  type ActionData,
  type ActionName,
} from "@/shared/protocol/actions";
import {
  actionResultSchema,
  type ActionResult,
} from "@/shared/protocol/result";
import {
  PROTOCOL_VERSION,
  serverFrameSchema,
  type AuthenticatedFrame,
  type EventFrame,
  type HelloFrame,
} from "@/shared/protocol/wire";

export class SmokeProtocolError extends Error {
  constructor(
    message: string,
    readonly result?: ActionResult<unknown>,
  ) {
    super(message);
    this.name = "SmokeProtocolError";
  }
}

export class SmokeProtocolClient {
  private socket: WebSocket | null = null;
  private sequence = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private helloWaiter: ((frame: HelloFrame) => void) | null = null;
  private authWaiters = new Map<
    string,
    (frame: AuthenticatedFrame) => void
  >();
  readonly events: EventFrame[] = [];
  hello: HelloFrame | null = null;
  userId: string | null = null;

  async connect(url: string): Promise<HelloFrame> {
    this.socket = new WebSocket(url, { origin: "http://127.0.0.1" });
    const hello = await new Promise<HelloFrame>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for protocol hello")),
        15_000,
      );
      this.helloWaiter = (frame) => {
        clearTimeout(timeout);
        resolve(frame);
      };
      this.socket!.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      this.socket!.on("message", (raw) => this.receive(raw.toString()));
    });
    this.hello = hello;
    return hello;
  }

  async call<K extends ActionName>(
    action: K,
    args: ActionArgs<K>,
    user: string | null = this.userId,
  ): Promise<ActionResult<ActionData<K>>> {
    if (!this.socket) throw new Error("Protocol client is not connected");
    const id = `smoke-${Date.now().toString(36)}-${++this.sequence}`;
    const payload = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out calling ${action}`)),
        30_000,
      );
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.socket!.send(
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
    const parsed = actionResultSchema(actionContracts[action].output).safeParse(
      payload,
    );
    if (!parsed.success) {
      throw new SmokeProtocolError(
        `${action} response did not match the Action result contract`,
      );
    }
    return parsed.data as ActionResult<ActionData<K>>;
  }

  async expectOk<K extends ActionName>(
    action: K,
    args: ActionArgs<K>,
    user?: string | null,
  ): Promise<ActionData<K>> {
    const result = await this.call(action, args, user);
    if (!result.ok) {
      throw new SmokeProtocolError(
        `${action} failed: ${result.error.message} (${result.error.incidentId})`,
        result,
      );
    }
    return result.data;
  }

  async authenticate(userId: string, token: string): Promise<void> {
    if (!this.socket) throw new Error("Protocol client is not connected");
    const frame = await new Promise<AuthenticatedFrame>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for authentication")),
        15_000,
      );
      this.authWaiters.set(userId, (authenticated) => {
        clearTimeout(timeout);
        resolve(authenticated);
      });
      this.socket!.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          kind: "authenticate",
          user: userId,
          token,
        }),
      );
    });
    if (!frame.result.ok) {
      throw new SmokeProtocolError(
        `authenticate failed: ${frame.result.error.message}`,
      );
    }
    this.userId = userId;
  }

  async loginWithPin(pin: string): Promise<{
    userId: string;
    token: string;
    handle: string;
    username: string;
  }> {
    const result = await this.expectOk("loginPinAction", [pin], null);
    if ("error" in result) {
      throw new SmokeProtocolError(`PIN login rejected: ${result.error}`);
    }
    if ("needs_oobe" in result) {
      throw new SmokeProtocolError("PIN login required OOBE unexpectedly");
    }
    if ("banned" in result) {
      throw new SmokeProtocolError(`PIN login banned user ${result.username}`);
    }
    await this.authenticate(result.user.id, result.token);
    return {
      userId: result.user.id,
      token: result.token,
      handle: result.user.handle,
      username: result.user.username,
    };
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error("Protocol client closed"));
    }
    this.pending.clear();
  }

  private receive(raw: string): void {
    const parsed = serverFrameSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.kind === "hello") {
      this.helloWaiter?.(frame);
      this.helloWaiter = null;
      return;
    }
    if (frame.kind === "authenticated") {
      const waiter = this.authWaiters.get(frame.user);
      this.authWaiters.delete(frame.user);
      waiter?.(frame);
      return;
    }
    if (frame.kind === "event") {
      this.events.push(frame);
      return;
    }
    const waiter = this.pending.get(frame.id);
    if (!waiter) return;
    this.pending.delete(frame.id);
    waiter.resolve(frame.result);
  }
}
