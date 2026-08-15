import type { RequestIdentity } from "@/server/runtime/scope";
import type { AuthorityService } from "@/server/services/authorityService";
import type { AppStateService } from "@/server/services/appStateService";
import type { ClientService } from "@/server/services/clientsService";
import type { HttpsUpgradeService } from "@/server/services/httpsUpgradeService";

export class AppFacade {
  constructor(
    private readonly identity: RequestIdentity,
    private readonly authority: AuthorityService,
    private readonly appState: AppStateService,
    private readonly clients: ClientService,
    private readonly https: HttpsUpgradeService,
  ) {}

  httpsRedirectEnabled(): boolean {
    return this.https.isRedirectEnabled();
  }

  probe(touch = true) {
    const user = this.authority.user();
    if (!user) {
      const clientId = this.clients.getOrCreateForIdentity(this.identity);
      return {
        ...this.appState.snapshotAnonymous(clientId),
        reason: "anonymous" as const,
      };
    }
    const clientId = this.clients.getIdByToken(this.identity.token ?? "") ?? "";
    if (!clientId) {
      return {
        v: 1 as const,
        konami_locked: true,
        session_valid: false,
        user: null,
        app: { disabled: false as const, reason: null },
        flags: this.appState.getConfig(),
        client_invalid: true as const,
      };
    }
    if (!this.clients.isIdentityAllowed(this.identity, clientId)) {
      return {
        ...this.appState.snapshotAuthenticated(user, clientId, { touch }),
        konami_locked: true,
      };
    }
    return this.appState.snapshotAuthenticated(user, clientId, { touch });
  }

  clientMe() {
    const clientId = this.clients.resolveRequestClientId({
      token: this.identity.token,
      identity: this.identity,
    });
    return {
      client_id: clientId ?? null,
      ip: this.identity.ip,
      client_invalid: !clientId || undefined,
    };
  }

  patchClientMe(locked: boolean) {
    const clientId = this.clients.resolveRequestClientId({
      token: this.identity.token,
      identity: this.identity,
    });
    if (!clientId) return { ok: false as const, client_invalid: true as const };
    if (!locked && !this.clients.isIdentityAllowed(this.identity, clientId)) {
      return {
        ok: false as const,
        access_required: true as const,
        client_id: clientId,
      };
    }
    this.clients.setKonamiLocked(clientId, locked);
    return { ok: true as const, konami_locked: locked };
  }
}
