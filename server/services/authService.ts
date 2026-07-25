import crypto from "crypto";
import type { Database } from "better-sqlite3";
import { generateToken, hashPin } from "@/server/infra/auth";
import {
  canClientLogin,
  checkClientThrottled,
  dedupeClientSessions,
  isClientKonamiLocked,
  recordLoginAttempt,
} from "@/server/data/clients";
import {
  deleteSessionByToken,
  findRecentSessionByClientId,
  findUserByPinHash,
  insertSession,
  replaceClientUserSession,
} from "@/server/data/auth";
import { createClientService } from "@/server/services/clientsService";
import {
  deleteGhostUserById,
  findGhostUserIdByOobeToken,
  findGhostUserIdByPinHash,
  issueGhostOobeToken,
} from "@/server/data/ghostUsers";
import {
  findUserIdByHandle,
  findUserPinOwnerId,
  getUser,
  getUserBanStatus,
  insertNewUser,
} from "@/server/data/users";
import { MalformedRequestError, CheckedError } from "@/shared/protocol/errors";
import type { User } from "@/shared/types/api";
import { DEFAULT_FEATURE_MASK } from "@/shared/features";
import type { ClientIdentity } from "@/server/infra/clientIdentity";

export interface LoginResult {
  user: User;
  token: string;
}

export interface LoginOobeResult {
  needs_oobe: true;
  oobe_token: string;
}

export interface LoginBannedResult {
  banned: true;
  banned_until: string;
  username: string;
}

export type LoginFlowResult = LoginResult | LoginOobeResult | LoginBannedResult;

export interface AutoLoginResult {
  user: User | null;
  token?: string;
  konami_locked: boolean;
  banned?: boolean;
  banned_until?: string;
  username?: string;
}

export interface CompleteOobeParams {
  oobe_token?: string;
  handle?: string;
  username?: string;
  new_pins?: string[];
}

export interface CompleteOobeResult {
  user: User;
  token: string;
}

function requirePinFormat(pin: string): string {
  if (!/^\d{6}$/.test(pin)) {
    throw new MalformedRequestError("PIN must be a 6-digit number");
  }
  return pin;
}

function requireHandleFormat(handle: string): string {
  if (!/^[a-zA-Z0-9_]{1,20}$/.test(handle)) {
    throw new MalformedRequestError(
      "Handle must contain only letters, numbers, and underscores, with max length 20",
    );
  }
  return handle;
}

function requireDisplayName(username: string): string {
  const displayName = username.trim();
  if (!displayName || displayName.length > 30) {
    throw new MalformedRequestError(
      "Display name must be non-empty and at most 30 characters",
    );
  }
  return displayName;
}

function requireNewPins(newPins: string[]): string[] {
  if (!Array.isArray(newPins) || newPins.length === 0 || newPins.length > 2) {
    throw new MalformedRequestError("Please provide 1 or 2 new PINs");
  }
  for (const pin of newPins) {
    requirePinFormat(pin);
  }
  if (newPins.length === 2 && newPins[0] === newPins[1]) {
    throw new MalformedRequestError("Two PINs must not be identical");
  }
  return newPins;
}

export interface AuthServiceDeps {
  createUserId: () => string;
  generateSessionToken: () => string;
  hashPinValue: (pin: string) => string;
}

const defaultDeps: AuthServiceDeps = {
  createUserId: () => crypto.randomUUID(),
  generateSessionToken: generateToken,
  hashPinValue: hashPin,
};

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly identity: ClientIdentity,
    private readonly deps: AuthServiceDeps,
  ) {}

  login(pin: string): LoginFlowResult {
    const normalizedPin = requirePinFormat(pin);
    const clients = createClientService(this.db);
    const clientId = clients.getOrCreateForIdentity(this.identity);
    if (!clients.isIdentityAllowed(this.identity, clientId)) {
      throw new CheckedError("FORBIDDEN", "该设备不在白名单中", 403);
    }
    const throttleStatus = checkClientThrottled(this.db, clientId);
    if (throttleStatus.throttled) {
      const mins = Math.ceil((throttleStatus.seconds ?? 0) / 60);
      throw new CheckedError(
        "THROTTLED",
        `错误次数过多，请等待 ${mins} 分钟`,
        429,
      );
    }

    const pinHash = this.deps.hashPinValue(normalizedPin);
    const ghostId = findGhostUserIdByPinHash(this.db, pinHash);
    if (ghostId) {
      if (clients.isBound(clientId)) {
        throw new CheckedError(
          "FORBIDDEN",
          "该客户端已绑定其他用户，不能用于新用户初始设置",
          403,
        );
      }
      recordLoginAttempt(this.db, clientId, true);
      return {
        needs_oobe: true,
        oobe_token: issueGhostOobeToken(this.db, ghostId),
      };
    }

    const found = findUserByPinHash(this.db, pinHash);
    if (!found) {
      recordLoginAttempt(this.db, clientId, false);
      throw new CheckedError("AUTHENTICATION_FAILED", "密码错误", 401);
    }
    if (!clients.canLoginUser(clientId, found.id)) {
      throw new CheckedError("FORBIDDEN", "该客户端已绑定其他用户", 403);
    }
    if (!canClientLogin(this.db, clientId, found.id)) {
      throw new CheckedError(
        "FORBIDDEN",
        "该客户端已登录两个账户，请先退出其中一个",
        403,
      );
    }

    const banStatus = getUserBanStatus(this.db, found.id);
    if (banStatus.banned) {
      recordLoginAttempt(this.db, clientId, true);
      return {
        banned: true,
        banned_until: banStatus.banned_until!,
        username: found.username,
      };
    }

    recordLoginAttempt(this.db, clientId, true);
    clients.unlock(clientId);

    const token = this.deps.generateSessionToken();
    this.db.transaction(() => {
      replaceClientUserSession(this.db, {
        clientId,
        userId: found.id,
        token,
      });
    })();

    return { user: found, token };
  }

  autoLogin(): AutoLoginResult {
    dedupeClientSessions(this.db);
    const clients = createClientService(this.db);

    const clientId = clients.getOrCreateForIdentity(this.identity);
    if (!clients.isIdentityAllowed(this.identity, clientId)) {
      return { user: null, konami_locked: true };
    }
    const state = isClientKonamiLocked(this.db, clientId);
    const clientState = { clientId, konamiLocked: state.konami_locked };

    const session = findRecentSessionByClientId(this.db, clientState.clientId);
    if (!session) {
      return { user: null, konami_locked: clientState.konamiLocked };
    }
    if (!clients.canLoginUser(clientId, session.user.id)) {
      return { user: null, konami_locked: clientState.konamiLocked };
    }

    const banStatus = getUserBanStatus(this.db, session.user.id);
    if (banStatus.banned) {
      return {
        user: null,
        konami_locked: clientState.konamiLocked,
        banned: true,
        banned_until: banStatus.banned_until!,
        username: session.user.username,
      };
    }

    return {
      user: session.user,
      token: session.token,
      konami_locked: clientState.konamiLocked,
    };
  }

  logout(token: string): void {
    deleteSessionByToken(this.db, token);
  }

  completeOobe(params: CompleteOobeParams): CompleteOobeResult {
    if (!params.oobe_token) {
      throw new MalformedRequestError("Missing OOBE token");
    }
    const ghostId = findGhostUserIdByOobeToken(this.db, params.oobe_token);
    if (!ghostId) {
      throw new CheckedError(
        "SESSION_EXPIRED",
        "OOBE 令牌已过期或无效，请重新登录",
        401,
        true,
      );
    }

    const handle = requireHandleFormat(params.handle ?? "");
    const displayName = requireDisplayName(params.username ?? "");
    const newPins = requireNewPins(params.new_pins ?? []);

    if (findUserIdByHandle(this.db, handle)) {
      throw new CheckedError("CONFLICT", "该 ID 已被占用", 409);
    }

    const nextPinHashes = newPins.map((pin) => this.deps.hashPinValue(pin));
    for (const pinHash of nextPinHashes) {
      if (
        findUserPinOwnerId(this.db, pinHash) ||
        findGhostUserIdByPinHash(this.db, pinHash)
      ) {
        throw new CheckedError("CONFLICT", "PIN 已被使用", 409);
      }
    }

    const clients = createClientService(this.db);
    const clientId = clients.getOrCreateForIdentity(this.identity);
    if (!clients.isIdentityAllowed(this.identity, clientId)) {
      throw new CheckedError("FORBIDDEN", "该设备不在白名单中", 403);
    }
    if (clients.isBound(clientId)) {
      throw new CheckedError(
        "FORBIDDEN",
        "该客户端已绑定其他用户，不能用于新用户初始设置",
        403,
      );
    }
    const userId = this.deps.createUserId();
    const token = this.deps.generateSessionToken();

    this.db.transaction(() => {
      insertNewUser(this.db, {
        id: userId,
        handle,
        username: displayName,
        featureMask: DEFAULT_FEATURE_MASK,
        pinHashes: nextPinHashes,
      });
      insertSession(this.db, { token, userId, clientId });
      deleteGhostUserById(this.db, ghostId);
      clients.unlock(clientId);
    })();

    const user = getUser(this.db, userId);
    if (!user) {
      throw new CheckedError("NOT_FOUND", "干员不存在", 404);
    }
    return { user, token };
  }
}

export function createAuthService(
  db: Database,
  identity: ClientIdentity,
  deps: Partial<AuthServiceDeps> = {},
): AuthService {
  return new AuthService(db, identity, { ...defaultDeps, ...deps });
}
