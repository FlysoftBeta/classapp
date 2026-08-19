import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { getOrCreateClient } from "@/server/data/clients";
import {
  clientChannel,
  subscribe,
  systemChannel,
  type BusEvent,
} from "@/server/runtime/eventBus";
import type { Coordinator } from "@/server/runtime/coordinator";
import {
  authenticateFrameSchema,
  actionNameSchema,
  PROTOCOL_VERSION,
  requestFrameSchema,
  type RequestFrame,
  type ResponseFrame,
} from "@/shared/protocol/wire";
import {
  ContractViolationError,
  PublicError,
  createIncidentService,
} from "@/server/services/incidentService";
import { ServerResultCodec } from "./errorCodec";
import {
  identifyClientRequest,
  type ClientIdentity,
} from "@/server/infra/clientIdentity";
import { BUILD_ID } from "@/server/infra/env";
import type { AuthenticateJobResult } from "@/server/runtime/executorIpc";
import type { ActionResult } from "@/shared/protocol/result";

function send(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

interface AuthenticatedBinding {
  userId: string;
  token: string;
  clientId: string | null;
  unsubscribe: () => void;
}

/** One physical WebSocket can carry several immutable authenticated actors. */
class ProtocolSession {
  private readonly bindings = new Map<string, AuthenticatedBinding>();
  private readonly anonymousClientId: string;
  private readonly unsubscribeBase: () => void;

  constructor(
    private readonly socket: WebSocket,
    private readonly identity: ClientIdentity,
    private readonly coordinator: Coordinator,
  ) {
    this.anonymousClientId = getOrCreateClient(coordinator.db, identity);
    this.unsubscribeBase = subscribe(
      [systemChannel(), clientChannel(this.anonymousClientId)],
      (event) => this.sendEvent(null, event),
    );
  }

  async authenticate(claimedUserId: string, token: string): Promise<void> {
    const job = await this.coordinator.execute({
      kind: "authenticate",
      claimedUserId,
      token,
      identity: this.identity,
    });
    if (job.outcome.ok) {
      const bound = job.outcome.data as AuthenticateJobResult;
      this.bind(bound.userId, token, bound.clientId, bound.channels);
    }
    send(this.socket, {
      v: PROTOCOL_VERSION,
      kind: "authenticated",
      user: claimedUserId,
      result: job.outcome.ok
        ? { ok: true }
        : { ok: false, error: job.outcome.error },
    });
  }

  async dispatch(frame: RequestFrame): Promise<void> {
    const binding = frame.user === null ? null : this.bindings.get(frame.user);
    const action = actionNameSchema.safeParse(frame.action);
    if (frame.user !== null && !binding) {
      await this.sendResult(
        frame.id,
        frame.user,
        await this.captureLocal(
          async () => {
            throw new PublicError("用户会话尚未完成认证");
          },
          frame.action,
          frame.id,
          frame.user,
        ),
      );
      return;
    }
    if (!action.success) {
      await this.sendResult(
        frame.id,
        frame.user,
        await this.captureLocal(
          async () => {
            throw new ContractViolationError("未知 Action", action.error.issues);
          },
          frame.action,
          frame.id,
          frame.user,
        ),
      );
      return;
    }
    const job = await this.coordinator.execute({
      kind: "action",
      action: action.data,
      args: frame.args,
      requestId: frame.id,
      identity: {
        token: binding?.token ?? null,
        userId: binding?.userId ?? null,
        clientId: binding?.clientId ?? this.anonymousClientId,
        ...this.identity,
        requestId: frame.id,
      },
    });
    await this.sendResult(frame.id, frame.user, job.outcome);
    if (job.outcome.ok && action.data === "logoutAction" && frame.user !== null) {
      this.unbind(frame.user);
    }
  }

  async rejectMalformed(
    id: string,
    user: string | null,
    issues: unknown[],
  ): Promise<void> {
    await this.respond(
      id,
      user,
      async () => {
        throw new ContractViolationError("请求帧格式错误", issues);
      },
      "protocol.request",
    );
  }

  recordProtocolViolation(error: unknown): string {
    return createIncidentService(this.coordinator.db, BUILD_ID).capture({
      environment: "server",
      error,
      context: { transport: "websocket", phase: "frame" },
    }).incidentId;
  }

  close(): void {
    this.unsubscribeBase();
    for (const binding of this.bindings.values()) binding.unsubscribe();
    this.bindings.clear();
  }

  private bind(
    userId: string,
    token: string,
    clientId: string | null,
    channels: string[],
  ): void {
    this.bindings.get(userId)?.unsubscribe();
    const unsubscribe = subscribe(channels, (event) =>
      this.sendEvent(userId, event),
    );
    this.bindings.set(userId, {
      userId,
      token,
      clientId,
      unsubscribe,
    });
  }

  private unbind(userId: string): void {
    this.bindings.get(userId)?.unsubscribe();
    this.bindings.delete(userId);
  }

  private async captureLocal(
    operation: () => Promise<unknown>,
    action: string | undefined,
    requestId: string,
    userId: string | null,
  ): Promise<ActionResult<unknown>> {
    return ServerResultCodec.capture(
      operation,
      { action, requestId, userId },
      this.coordinator.db,
    );
  }

  private async sendResult(
    id: string,
    user: string | null,
    result: ActionResult<unknown>,
  ): Promise<void> {
    send(this.socket, {
      v: PROTOCOL_VERSION,
      kind: "response",
      id,
      user,
      result,
    } satisfies ResponseFrame);
  }

  private async respond(
    id: string,
    user: string | null,
    operation: () => Promise<unknown>,
    action?: string,
  ): Promise<boolean> {
    const result = await this.captureLocal(operation, action, id, user);
    await this.sendResult(id, user, result);
    return result.ok;
  }

  private sendEvent(user: string | null, event: BusEvent): void {
    send(this.socket, {
      v: PROTOCOL_VERSION,
      kind: "event",
      user,
      event: event.kind,
      data: event.data,
    });
  }
}

export class WebSocketProtocol {
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    private readonly buildId: string,
    private readonly coordinator: Coordinator,
  ) {
    this.wss.on("connection", (socket, request) =>
      this.connected(socket, request),
    );
  }

  attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname !== "/ws") return;
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request);
      });
    });
  }

  close(): void {
    for (const client of this.wss.clients)
      client.close(1001, "server shutdown");
    this.wss.close();
  }

  private connected(socket: WebSocket, request: IncomingMessage): void {
    const session = new ProtocolSession(
      socket,
      identifyClientRequest(request),
      this.coordinator,
    );
    send(socket, { v: PROTOCOL_VERSION, kind: "hello", buildId: this.buildId });

    socket.on("message", (bytes) => {
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.toString());
      } catch (error) {
        const id = session.recordProtocolViolation(
          new ContractViolationError("WebSocket frame 不是合法 JSON", error),
        );
        socket.close(1003, `invalid JSON ${id}`);
        return;
      }

      if (!raw || typeof raw !== "object" || !("kind" in raw)) {
        const id = session.recordProtocolViolation(
          new ContractViolationError("WebSocket frame 缺少 kind"),
        );
        socket.close(1008, `invalid frame ${id}`);
        return;
      }

      if (raw.kind === "authenticate") {
        const authentication = authenticateFrameSchema.safeParse(raw);
        if (!authentication.success) {
          const id = session.recordProtocolViolation(
            new ContractViolationError(
              "认证 frame 不符合协议",
              authentication.error.issues,
            ),
          );
          socket.close(1008, `invalid authentication ${id}`);
          return;
        }
        void session.authenticate(
          authentication.data.user,
          authentication.data.token,
        );
        return;
      }

      if (raw.kind === "request") {
        const parsed = requestFrameSchema.safeParse(raw);
        if (parsed.success) {
          void session.dispatch(parsed.data);
          return;
        }
        const id = "id" in raw && typeof raw.id === "string" ? raw.id : "";
        const user =
          "user" in raw && (typeof raw.user === "string" || raw.user === null)
            ? raw.user
            : null;
        if (id.length > 0 && id.length <= 128) {
          void session.rejectMalformed(id, user, parsed.error.issues);
        } else {
          const incidentId = session.recordProtocolViolation(
            new ContractViolationError(
              "请求 frame 不符合协议",
              parsed.error.issues,
            ),
          );
          socket.close(1008, `invalid request ${incidentId}`);
        }
        return;
      }

      const id = session.recordProtocolViolation(
        new ContractViolationError("未知 WebSocket frame kind"),
      );
      socket.close(1008, `unknown frame ${id}`);
    });
    socket.on("close", () => session.close());
  }
}
