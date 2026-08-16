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
  type ActionResult,
} from "@/shared/protocol/result";
import { RemoteIncidentError, type IncidentId } from "@/shared/protocol/errors";
import { PROTOCOL_VERSION, serverFrameSchema } from "@/shared/protocol/wire";
import { session } from "./session";
import {
  transport,
  TransportUnavailableError,
  type TransportState,
} from "./transport";
import {
  ClientIncidentContext,
  recordRemoteIncident,
  reportDetachedClientFailure,
} from "@/client/interact/incidentContext";

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
  authEpoch: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  context: ClientIncidentContext;
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
    session.onBindingInvalidated((userId, credentialEpoch, error) => {
      this.rejectActorPending(userId, credentialEpoch, error);
    });
  }

  isConnected(): boolean {
    return transport.isConnected();
  }

  call<K extends ActionName>(
    action: K,
    ...args: ActionArgs<K>
  ): Promise<ActionResult<ActionData<K>>> {
    const context = new ClientIncidentContext(
      action,
      session.getUserId(),
      session.getCredentialEpoch(session.getUserId()),
    );
    return this.callInContext(context, action, ...args);
  }

  callInContext<K extends ActionName>(
    context: ClientIncidentContext,
    action: K,
    ...args: ActionArgs<K>
  ): Promise<ActionResult<ActionData<K>>> {
    return session
      .waitUntilAuthenticated(context.actorId)
      .then(() => this.send(context, action, args));
  }

  private send<K extends ActionName>(
    context: ClientIncidentContext,
    action: K,
    args: ActionArgs<K>,
  ): Promise<ActionResult<ActionData<K>>> {
    if (!transport.isConnected()) {
      throw new TransportUnavailableError();
    }
    const id = `${Date.now().toString(36)}-${++this.sequence}`;
    // Actions have no per-request timeout. Pending requests are rejected when
    // the WebSocket disconnects or the actor binding is invalidated; a server
    // that silently never answers would otherwise wait as long as the socket.
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, {
        action,
        authEpoch: session.getCredentialEpoch(context.actorId),
        resolve,
        reject,
        context,
      });
    });
    try {
      transport.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          kind: "request",
          id,
          user: context.actorId,
          action,
          args,
        }),
      );
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.reject(error);
      }
    }
    return result as Promise<ActionResult<ActionData<K>>>;
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
    } catch (error) {
      reportDetachedClientFailure(
        "remote.frame.json",
        new RemoteProtocolError("INVALID_JSON", "服务端发送了无效 JSON", error),
      );
      return;
    }
    const decoded = serverFrameSchema.safeParse(json);
    if (!decoded.success) {
      reportDetachedClientFailure(
        "remote.frame.contract",
        new RemoteProtocolError(
          "INVALID_FRAME",
          "服务端 frame 不符合协议",
          decoded.error.issues,
        ),
      );
      return;
    }
    const frame = decoded.data;
    if (frame.kind === "hello") {
      this.buildId = frame.buildId;
      this.dispatch("remote.hello", { buildId: frame.buildId });
      return;
    }
    if (frame.kind === "authenticated") {
      session.observeAuthenticated(frame);
      return;
    }
    if (frame.kind === "event") {
      if (frame.event === "remote.resubscribe" && frame.user !== null) {
        // Re-authentication atomically replaces the server-side channel set
        // for this user without disturbing other bindings on the transport.
        session.refreshAuthentication(frame.user);
      }
      if (frame.user !== null && frame.user !== session.getUserId()) return;
      const contract = eventContracts[frame.event];
      const data = contract.safeParse(frame.data);
      if (data.success) {
        this.dispatch(frame.event, data.data);
      } else {
        reportDetachedClientFailure(
          `remote.event.${frame.event}`,
          new RemoteProtocolError(
            "INVALID_EVENT",
            "服务端 Event payload 不符合契约",
            data.error.issues,
          ),
        );
      }
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.user !== pending.context.actorId) {
      pending.reject(
        new RemoteProtocolError("ACTOR_MISMATCH", "服务响应的用户上下文不匹配"),
      );
      return;
    }
    if (
      pending.authEpoch !== session.getCredentialEpoch(pending.context.actorId)
    ) {
      pending.reject(
        new RemoteProtocolError("ACTOR_CHANGED", "登录身份已切换"),
      );
      return;
    }
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
    if (!result.data.ok) {
      const incidentId = result.data.error.incidentId as IncidentId;
      pending.context.linkIncident(incidentId);
      recordRemoteIncident(pending.context.actorId, incidentId);
      pending.reject(
        new RemoteIncidentError(result.data.error.message, [incidentId]),
      );
      return;
    }
    pending.resolve(result.data);
  }

  private dispatch<K extends EventName>(event: K, data: EventData<K>): void {
    for (const key of [event, "*"] as const) {
      for (const listener of this.eventListeners.get(key) ?? []) {
        try {
          listener(data);
        } catch (error) {
          // Event fan-out is a containment boundary, so report and continue.
          reportDetachedClientFailure(`remote.listener.${event}`, error);
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
    this.rejectPending(
      new RemoteProtocolError("DISCONNECTED", "服务连接已断开"),
    );
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectActorPending(
    userId: string,
    credentialEpoch: number,
    error: unknown,
  ): void {
    for (const [id, pending] of this.pending) {
      if (
        pending.context.actorId !== userId ||
        pending.authEpoch !== credentialEpoch
      ) {
        continue;
      }
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export const client = new Client();
