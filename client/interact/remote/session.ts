import {
  PROTOCOL_VERSION,
  type AuthenticatedFrame,
} from "@/shared/protocol/wire";
import { RemoteIncidentError } from "@/shared/protocol/errors";
import {
  transport,
  TransportUnavailableError,
  type TransportState,
} from "./transport";
import { recordRemoteIncident } from "@/client/interact/incidentContext";

type InvalidHandler = () => void;
type TokenListener = (epoch: number) => void;
type BindingListener = (
  userId: string,
  credentialEpoch: number,
  error: unknown,
) => void;

interface Binding {
  token: string;
  credentialEpoch: number;
  authenticated: boolean;
  waiters: Set<{
    resolve: () => void;
    reject: (error: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
}

class RemoteSession {
  private readonly bindings = new Map<string, Binding>();
  private activeUserId: string | null = null;
  private activeEpoch = 0;
  private credentialSequence = 0;
  private invalidHandler: InvalidHandler | null = null;
  private tokenListeners = new Set<TokenListener>();
  private bindingListeners = new Set<BindingListener>();

  constructor() {
    transport.onStateChange((state) => this.handleTransportState(state));
  }

  getToken(): string {
    return this.activeUserId
      ? (this.bindings.get(this.activeUserId)?.token ?? "")
      : "";
  }

  getUserId(): string | null {
    return this.activeUserId;
  }

  getEpoch(): number {
    return this.activeEpoch;
  }

  getCredentialEpoch(userId: string | null): number {
    return userId ? (this.bindings.get(userId)?.credentialEpoch ?? -1) : 0;
  }

  onTokenChange(listener: TokenListener): () => void {
    this.tokenListeners.add(listener);
    return () => this.tokenListeners.delete(listener);
  }

  onBindingInvalidated(listener: BindingListener): () => void {
    this.bindingListeners.add(listener);
    return () => this.bindingListeners.delete(listener);
  }

  bind(userId: string, token: string): void {
    const current = this.bindings.get(userId);
    if (current?.token === token) {
      if (this.activeUserId !== userId) {
        this.activeUserId = userId;
        this.bumpActiveEpoch();
      }
      return;
    }
    if (current) {
      const error = new Error("认证凭据已替换");
      this.rejectWaiters(current, error);
      this.invalidateBinding(userId, current, error);
    }
    this.bindings.set(userId, {
      token,
      credentialEpoch: ++this.credentialSequence,
      authenticated: false,
      waiters: new Set(),
    });
    this.activeUserId = userId;
    this.bumpActiveEpoch();
    this.authenticate(userId);
  }

  clearActive(): void {
    if (!this.activeUserId) return;
    const binding = this.bindings.get(this.activeUserId);
    if (binding) {
      const error = new Error("用户会话已清除");
      this.rejectWaiters(binding, error);
      this.bindings.delete(this.activeUserId);
      this.invalidateBinding(this.activeUserId, binding, error);
    }
    this.activeUserId = null;
    this.bumpActiveEpoch();
  }

  async waitUntilAuthenticated(userId: string | null): Promise<void> {
    if (userId === null) return Promise.resolve();
    const binding = this.bindings.get(userId);
    if (!binding) return Promise.reject(new Error("用户会话不存在"));
    if (binding.authenticated) return Promise.resolve();
    if (!transport.isConnected()) {
      await transport.waitForCurrentAttempt();
      return this.waitUntilAuthenticated(userId);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          binding.waiters.delete(waiter);
          reject(new TransportUnavailableError("会话认证超时"));
        }, 5_000),
      };
      binding.waiters.add(waiter);
    });
  }

  observeAuthenticated(frame: AuthenticatedFrame): void {
    const binding = this.bindings.get(frame.user);
    if (!binding) return;
    if (!frame.result.ok) {
      const error = new RemoteIncidentError(frame.result.error.message, [
        frame.result.error.incidentId,
      ]);
      recordRemoteIncident(frame.user, frame.result.error.incidentId);
      this.rejectWaiters(binding, error);
      this.bindings.delete(frame.user);
      this.invalidateBinding(frame.user, binding, error);
      if (this.activeUserId === frame.user) {
        this.activeUserId = null;
        this.bumpActiveEpoch();
        this.invalidHandler?.();
      }
      return;
    }
    binding.authenticated = true;
    for (const waiter of binding.waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    binding.waiters.clear();
  }

  setInvalidHandler(handler: InvalidHandler | null): void {
    this.invalidHandler = handler;
  }

  refreshAuthentication(userId: string): void {
    this.authenticate(userId);
  }

  private handleTransportState(state: TransportState): void {
    if (state.kind === "connected") {
      for (const userId of this.bindings.keys()) this.authenticate(userId);
      return;
    }
    for (const binding of this.bindings.values()) {
      binding.authenticated = false;
      this.rejectWaiters(binding, new TransportUnavailableError());
    }
  }

  private authenticate(userId: string): void {
    const binding = this.bindings.get(userId);
    if (!binding || !transport.isConnected()) return;
    binding.authenticated = false;
    transport.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        kind: "authenticate",
        user: userId,
        token: binding.token,
      }),
    );
  }

  private bumpActiveEpoch(): void {
    this.activeEpoch += 1;
    for (const listener of this.tokenListeners) listener(this.activeEpoch);
  }

  private invalidateBinding(
    userId: string,
    binding: Binding,
    error: unknown,
  ): void {
    for (const listener of this.bindingListeners) {
      listener(userId, binding.credentialEpoch, error);
    }
  }

  private rejectWaiters(binding: Binding, error: unknown): void {
    for (const waiter of binding.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    binding.waiters.clear();
  }
}

export const session = new RemoteSession();
