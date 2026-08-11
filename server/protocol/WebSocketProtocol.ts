import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { getDb } from "@/server/infra/db";
import { getUserFromToken } from "@/server/infra/auth";
import { getClientIdFromToken, getOrCreateClient } from "@/server/data/clients";
import {
  listEventDmPartnerIds,
  listEventGroupIds,
} from "@/server/data/eventSubscriptions";
import { isUserBanned } from "@/server/domain/policy/auth";
import {
  clientChannel,
  dmPostChannel,
  groupArticleChannel,
  groupPostChannel,
  subscribe,
  systemChannel,
  userChannel,
  userConvChannel,
  type BusEvent,
} from "@/server/services/eventBus";
import { withRequestContext } from "@/server/session/requestContext";
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
import { dispatchAction } from "./registry";
import { ServerResultCodec } from "./errorCodec";
import {
  identifyClientRequest,
  type ClientIdentity,
} from "@/server/infra/clientIdentity";
import type { User } from "@/shared/types/api";
import { BUILD_ID } from "@/server/infra/env";

function send(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

function userChannels(userId: string): string[] {
  const db = getDb();
  const channels = [userChannel(userId), userConvChannel(userId)];
  for (const groupId of listEventGroupIds(db, userId)) {
    channels.push(groupPostChannel(groupId), groupArticleChannel(groupId));
  }
  for (const partnerId of listEventDmPartnerIds(db, userId)) {
    channels.push(dmPostChannel(userId, partnerId));
  }
  return channels;
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
  ) {
    this.anonymousClientId = getOrCreateClient(getDb(), identity);
    this.unsubscribeBase = subscribe(
      [systemChannel(), clientChannel(this.anonymousClientId)],
      (event) => this.sendEvent(null, event),
    );
  }

  async authenticate(claimedUserId: string, token: string): Promise<void> {
    const result = await ServerResultCodec.capture(
      async () => {
        const normalized = token.trim();
        const user = normalized ? getUserFromToken(normalized) : null;
        if (!user) throw new PublicError("会话认证失败");
        if (user.id !== claimedUserId) {
          throw new ContractViolationError("认证用户与 token 不匹配");
        }
        if (isUserBanned(user.id)) throw new PublicError("当前用户已被封禁");
        this.bind(user, normalized);
        return undefined;
      },
      {
        action: "remote.authenticate",
        userId: claimedUserId,
      },
    );
    send(this.socket, {
      v: PROTOCOL_VERSION,
      kind: "authenticated",
      user: claimedUserId,
      result: result.ok ? { ok: true } : { ok: false, error: result.error },
    });
  }

  async dispatch(frame: RequestFrame): Promise<void> {
    const binding = frame.user === null ? null : this.bindings.get(frame.user);
    let dispatchedAction: string | null = null;
    const succeeded = await this.respond(
      frame.id,
      frame.user,
      async () => {
        if (frame.user !== null && !binding) {
          throw new PublicError("用户会话尚未完成认证");
        }
        const action = actionNameSchema.safeParse(frame.action);
        if (!action.success) {
          throw new ContractViolationError("未知 Action", action.error.issues);
        }
        dispatchedAction = action.data;
        return withRequestContext(
          {
            token: binding?.token ?? null,
            userId: binding?.userId ?? null,
            clientId: binding?.clientId ?? this.anonymousClientId,
            ...this.identity,
          },
          () => dispatchAction(action.data, frame.args),
        );
      },
      frame.action,
    );
    if (
      succeeded &&
      dispatchedAction === "logoutAction" &&
      frame.user !== null
    ) {
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
    return createIncidentService(getDb(), BUILD_ID).capture({
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

  private bind(user: User, token: string): void {
    this.bindings.get(user.id)?.unsubscribe();
    const clientId = getClientIdFromToken(getDb(), token) ?? null;
    const unsubscribe = subscribe(userChannels(user.id), (event) =>
      this.sendEvent(user.id, event),
    );
    this.bindings.set(user.id, {
      userId: user.id,
      token,
      clientId,
      unsubscribe,
    });
  }

  private unbind(userId: string): void {
    this.bindings.get(userId)?.unsubscribe();
    this.bindings.delete(userId);
  }

  private async respond(
    id: string,
    user: string | null,
    operation: () => Promise<unknown>,
    action?: string,
  ): Promise<boolean> {
    const result = await ServerResultCodec.capture(operation, {
      action,
      requestId: id,
      userId: user,
    });
    send(this.socket, {
      v: PROTOCOL_VERSION,
      kind: "response",
      id,
      user,
      result,
    } satisfies ResponseFrame);
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

  constructor(private readonly buildId: string) {
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
    const session = new ProtocolSession(socket, identifyClientRequest(request));
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
