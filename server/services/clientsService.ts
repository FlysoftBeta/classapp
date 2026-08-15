import type BetterSqlite3 from "better-sqlite3";
import {
  countClients,
  deleteClient,
  getClientIdFromToken,
  getClientStoredState,
  isClientKonamiLocked,
  getOrCreateClient,
  getClientAccessConfig,
  identityBelongsToClient,
  listClientAdminRows,
  listRecentClientSessionUsers,
  lockClient,
  promoteClient,
  updateClientAccessConfig,
  updatePersistentClientProps,
  unlockClient,
  type ClientAccessConfig,
  type ClientIdentityMethod,
  clearUserClientReferences,
  isActiveBoundUser,
} from "@/server/data/clients";
import { publishClient } from "@/server/services/eventBus";
import type { ClientIdentity } from "@/server/infra/clientIdentity";
import { userMetadataForIds } from "@/server/data/users";
import type { UserMetadata } from "@/shared/types/api";

export interface ClientRecord {
  id: string;
  created_at: string;
  persistent: boolean;
  remark: string;
  ips: string[];
  last_seen: string | null;
  active_sessions: number;
  session_user_ids: string[];
  konami_locked: boolean;
  throttled_until: string | null;
  attempts: number;
  mac: string | null;
  user_agent: string | null;
  whitelisted: boolean;
  bound_user_id: string | null;
}

export class ClientService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  getOrCreateForIdentity(identity: ClientIdentity): string {
    return getOrCreateClient(this.db, identity);
  }

  getOrCreateForIp(ip: string): string {
    return this.getOrCreateForIdentity({ ip, userAgent: "", mac: null });
  }

  getIdByToken(token: string): string | null {
    return getClientIdFromToken(this.db, token);
  }

  resolveRequestClientId(input: {
    token: string | null | undefined;
    identity: ClientIdentity;
  }): string | null {
    return input.token
      ? this.getIdByToken(input.token)
      : this.getOrCreateForIdentity(input.identity);
  }

  list(
    offset = 0,
    limit = 50,
    query = "",
  ): { clients: ClientRecord[]; users: UserMetadata[]; total: number } {
    const total = countClients(this.db, query);
    const clients = listClientAdminRows(this.db, offset, limit, query).map(
      (row) => {
        const sessionUsers = listRecentClientSessionUsers(this.db, row.id);
        return {
          id: row.id,
          created_at: row.created_at,
          persistent: row.persistent === 1,
          remark: row.remark,
          ips: row.ips ? row.ips.split(",").filter(Boolean) : [],
          last_seen: row.last_seen,
          active_sessions: sessionUsers.length,
          session_user_ids: sessionUsers.map((session) => session.id),
          konami_locked: row.konami_locked === 1,
          throttled_until: row.throttled_until,
          attempts: row.attempts ?? 0,
          mac: row.mac,
          user_agent: row.user_agent,
          whitelisted: row.whitelisted === 1,
          bound_user_id: row.bound_user_id,
        };
      },
    );
    return {
      clients,
      users: userMetadataForIds(
        this.db,
        clients.flatMap((client) => [
          client.bound_user_id,
          ...client.session_user_ids,
        ]),
      ),
      total,
    };
  }

  setKonamiLocked(clientId: string, locked: boolean): void {
    if (locked) {
      lockClient(this.db, clientId);
      publishClient(clientId, {
        kind: "client.lock_changed",
        data: { konami_locked: true },
      });
      return;
    }
    this.unlock(clientId);
  }

  lock(clientId: string): void {
    this.setKonamiLocked(clientId, true);
  }

  unlock(clientId: string): void {
    unlockClient(this.db, clientId);
    publishClient(clientId, {
      kind: "client.lock_changed",
      data: { konami_locked: false },
    });
  }

  whitelist(clientId: string): void {
    if (
      !updatePersistentClientProps(this.db, clientId, { whitelisted: true })
    ) {
      throw new Error("客户端不存在");
    }
    publishClient(clientId, {
      kind: "client.lock_changed",
      data: {
        konami_locked: isClientKonamiLocked(this.db, clientId).konami_locked,
      },
    });
  }

  promote(clientId: string): void {
    if (!promoteClient(this.db, clientId)) throw new Error("客户端不存在");
  }

  updateProps(
    clientId: string,
    input: {
      remark?: string;
      whitelisted?: boolean;
      bound_user_id?: string | null;
    },
  ): void {
    if (!updatePersistentClientProps(this.db, clientId, input)) {
      throw new Error("客户端不存在");
    }
    publishClient(clientId, {
      kind: "client.lock_changed",
      data: {
        konami_locked: isClientKonamiLocked(this.db, clientId).konami_locked,
      },
    });
  }

  config(): ClientAccessConfig {
    return getClientAccessConfig(this.db);
  }

  updateConfig(input: {
    whitelist_enabled?: boolean;
    identity_methods?: ClientIdentityMethod[];
  }): ClientAccessConfig {
    return updateClientAccessConfig(this.db, input);
  }

  isIdentityAllowed(identity: ClientIdentity, clientId?: string): boolean {
    const config = this.config();
    if (!config.whitelist_enabled) return true;
    if (!clientId) return false;
    const state = getClientStoredState(this.db, clientId);
    return !!(
      state?.persistent &&
      state.whitelisted &&
      identityBelongsToClient(this.db, clientId, identity)
    );
  }

  canLoginUser(clientId: string, userId: string): boolean {
    const state = getClientStoredState(this.db, clientId);
    return (
      !!state &&
      (!state.bound_user_id ||
        state.bound_user_id === userId ||
        !isActiveBoundUser(this.db, state.bound_user_id))
    );
  }

  isBound(clientId: string): boolean {
    const userId = getClientStoredState(this.db, clientId)?.bound_user_id;
    return !!userId && isActiveBoundUser(this.db, userId);
  }

  delete(clientId: string): boolean {
    const deleted = deleteClient(this.db, clientId);
    if (deleted) {
      publishClient(clientId, { kind: "client.deleted", data: {} });
    }
    return deleted;
  }

  purgeUser(userId: string): void {
    for (const clientId of clearUserClientReferences(this.db, userId)) {
      publishClient(clientId, {
        kind: "client.lock_changed",
        data: {
          konami_locked: isClientKonamiLocked(this.db, clientId).konami_locked,
        },
      });
    }
  }
}

export function createClientService(db: BetterSqlite3.Database): ClientService {
  return new ClientService(db);
}
