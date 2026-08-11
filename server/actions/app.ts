import { getDb } from "@/server/infra/db";
import { withActionSession, expectBoolean } from "./_base";
import { actionClientIdentity } from "@/server/session/session";
import { createAppStateService } from "@/server/services/appStateService";
import { createClientService } from "@/server/services/clientsService";
import type { ActionInput } from "@/shared/protocol/actions";

export async function probeAppStateAction(
  opts?: ActionInput<"probeAppStateAction">,
) {
  return withActionSession(async (session) => {
    const db = getDb();
    const appState = createAppStateService(db);
    const clients = createClientService(db);
    const token = session.tokenValue();
    const user = await session.user();

    if (!user) {
      const clientId = clients.getOrCreateForIdentity(actionClientIdentity());
      return {
        ...appState.snapshotAnonymous(clientId),
        reason: "anonymous" as const,
      };
    }

    const clientId = clients.getIdByToken(token ?? "") ?? "";
    if (!clientId) {
      return {
        v: 1 as const,
        konami_locked: true,
        session_valid: false,
        user: null,
        app: { disabled: false, reason: null },
        flags: appState.getConfig(),
        client_invalid: true,
      };
    }

    if (!clients.isIdentityAllowed(actionClientIdentity(), clientId)) {
      return {
        ...appState.snapshotAuthenticated(user, clientId, {
          touch: opts?.touch !== false,
        }),
        konami_locked: true,
      };
    }

    return appState.snapshotAuthenticated(user, clientId, {
      touch: opts?.touch !== false,
    });
  });
}

export async function getClientMeAction() {
  return withActionSession(async (session) => {
    const db = getDb();
    const token = session.tokenValue();
    const identity = actionClientIdentity();
    const clientId = createClientService(db).resolveRequestClientId({
      token,
      identity,
    });

    return {
      client_id: clientId ?? null,
      ip: identity.ip,
      client_invalid: !clientId || undefined,
    };
  });
}

export async function patchClientMeAction(
  konami_locked: ActionInput<"patchClientMeAction">,
) {
  return withActionSession(async (session) => {
    const db = getDb();
    const clients = createClientService(db);
    const identity = actionClientIdentity();
    const token = session.tokenValue();
    const clientId = clients.resolveRequestClientId({ token, identity });

    if (!clientId) {
      return {
        ok: false as const,
        client_invalid: true as const,
      };
    }

    const locked = expectBoolean(konami_locked, "参数错误");
    if (!locked && !clients.isIdentityAllowed(identity, clientId)) {
      return {
        ok: false as const,
        access_required: true as const,
        client_id: clientId,
      };
    }
    clients.setKonamiLocked(clientId, locked);

    return {
      ok: true as const,
      konami_locked: locked,
    };
  });
}
