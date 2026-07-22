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
import { MalformedRequestError } from "@/shared/protocol/errors";
import { dispatchAction } from "./registry";
import { ServerResultCodec } from "./errorCodec";
import {
  identifyClientRequest,
  type ClientIdentity,
} from "@/server/infra/clientIdentity";

function send(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

function channelsFor(token: string, identity: ClientIdentity): string[] {
  const db = getDb();
  const channels = [systemChannel()];
  const user = token ? getUserFromToken(token) : null;
  if (!user || isUserBanned(user.id)) {
    channels.push(clientChannel(getOrCreateClient(db, identity)));
    return channels;
  }
  const clientId = getClientIdFromToken(db, token);
  if (clientId) channels.push(clientChannel(clientId));
  channels.push(userChannel(user.id), userConvChannel(user.id));
  for (const groupId of listEventGroupIds(db, user.id)) {
    channels.push(groupPostChannel(groupId));
    channels.push(groupArticleChannel(groupId));
  }
  for (const partnerId of listEventDmPartnerIds(db, user.id)) {
    channels.push(dmPostChannel(user.id, partnerId));
  }
  return channels;
}

/** Stateful server-side protocol session for one WebSocket connection. */
class ProtocolSession {
  private token = "";
  private unsubscribe = () => {};

  constructor(
    private readonly socket: WebSocket,
    private readonly identity: ClientIdentity,
  ) {
    this.resubscribe();
  }

  authenticate(token: string): void {
    this.token = token.trim();
    this.resubscribe();
  }

  async dispatch(frame: RequestFrame): Promise<void> {
    await this.respond(frame.id, async () => {
      const action = actionNameSchema.safeParse(frame.action);
      if (!action.success) {
        throw new MalformedRequestError("未知 Action", action.error.issues);
      }
      return withRequestContext(
        { token: this.token || null, ...this.identity },
        () => dispatchAction(action.data, frame.args),
      );
    });
  }

  async rejectMalformed(id: string, issues: unknown[]): Promise<void> {
    await this.respond(id, async () => {
      throw new MalformedRequestError("请求帧格式错误", issues);
    });
  }

  private async respond(
    id: string,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    const result = await ServerResultCodec.capture(operation);
    send(this.socket, {
      v: PROTOCOL_VERSION,
      kind: "response",
      id,
      result,
    } satisfies ResponseFrame);
  }

  close(): void {
    this.unsubscribe();
  }

  private resubscribe(): void {
    this.unsubscribe();
    this.unsubscribe = subscribe(
      channelsFor(this.token, this.identity),
      (event: BusEvent) => {
        send(this.socket, {
          v: PROTOCOL_VERSION,
          kind: "event",
          event: event.kind,
          data: event.data,
        });
      },
    );
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
      } catch {
        socket.close(1003, "invalid JSON");
        return;
      }

      if (!raw || typeof raw !== "object" || !("kind" in raw)) {
        socket.close(1008, "invalid protocol frame");
        return;
      }

      if (raw.kind === "authenticate") {
        const authentication = authenticateFrameSchema.safeParse(raw);
        if (!authentication.success) {
          socket.close(1008, "invalid authentication frame");
          return;
        }
        session.authenticate(authentication.data.token);
        return;
      }

      if (raw.kind === "request") {
        const request = requestFrameSchema.safeParse(raw);
        if (request.success) {
          void session.dispatch(request.data);
          return;
        }
        const id = "id" in raw && typeof raw.id === "string" ? raw.id : "";
        if (id.length > 0 && id.length <= 128) {
          void session.rejectMalformed(id, request.error.issues);
        } else {
          socket.close(1008, "invalid request frame");
        }
        return;
      }

      socket.close(1008, "unknown protocol frame");
    });
    socket.on("close", () => session.close());
  }
}
