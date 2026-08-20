import type { Database } from "better-sqlite3";
import {
  capabilitySourceId,
  capabilitySourceKind,
  recoverySource,
  type CapabilitySource,
} from "@/shared/access";
import {
  deletePossession,
  readPossession,
  upsertPossession,
} from "@/server/data/possession";
import type { AccessService } from "@/server/services/accessService";
import { AuthorizationError } from "@/server/services/authorizationError";
import { CapabilityService } from "@/server/services/capabilityService";

export interface HeldCapability {
  capability: string;
  recovered: boolean;
}

/** A collection that currently contains an ownerless object. */
export interface ContainingCollection {
  kind: string;
  id: string;
  revision?: number;
}

/**
 * Domain port: which owned collections currently contain this object.
 * Recovery then asks AccessService whether the user can still read one.
 */
export interface OwnerlessRecovery {
  collectionsContaining(
    objectKind: string,
    objectId: string,
  ): ContainingCollection[];
}

const EMPTY_RECOVERY: OwnerlessRecovery = {
  collectionsContaining: () => [],
};

/**
 * Ownerless capabilities: HMAC tokens and a per-user possession cache.
 * Holding an unexpired token is enough. There is no access binding on the
 * object. Recovery mints a new token only from a still-readable collection.
 */
export class OwnerlessCapabilityService {
  constructor(
    private readonly db: Database,
    private readonly hmac: CapabilityService,
    private readonly owned: AccessService,
    private readonly recovery: OwnerlessRecovery = EMPTY_RECOVERY,
  ) {}

  issue(
    kind: string,
    id: string,
    source: CapabilitySource,
    now = Date.now(),
  ): string {
    return this.hmac.sign(kind, id, source, now);
  }

  remember(
    userId: string,
    kind: string,
    id: string,
    capability: string,
    now = Date.now(),
  ): void {
    const verified = this.hmac.verify(capability, { kind, id }, now);
    if (!verified.ok) return;
    const stored = readPossession(this.db, userId, kind, id);
    if (stored) {
      const existing = this.hmac.verify(stored.capability, { kind, id }, now);
      if (existing.ok && existing.payload.exp >= verified.payload.exp) return;
    }
    upsertPossession(this.db, {
      userId,
      resourceKind: kind,
      resourceId: id,
      capability,
      sourceKind: capabilitySourceKind(verified.payload.src),
      sourceId: capabilitySourceId(verified.payload.src),
      expiresAtMs: verified.payload.exp,
    });
  }

  /**
   * Present a token or reuse stored possession. Recover from a readable
   * containing collection only when nothing valid is already held.
   */
  require(
    userId: string,
    kind: string,
    id: string,
    capability?: string,
    now = Date.now(),
  ): HeldCapability {
    if (capability) {
      const presented = this.hmac.verify(capability, { kind, id }, now);
      if (presented.ok) {
        this.remember(userId, kind, id, presented.token, now);
        return { capability: presented.token, recovered: false };
      }
      if (
        presented.reason === "kind_mismatch" ||
        presented.reason === "id_mismatch" ||
        presented.reason === "invalid"
      ) {
        const recovered = this.recover(userId, kind, id, now);
        if (recovered) return recovered;
        throw new AuthorizationError("invalid_capability");
      }
    }

    const stored = readPossession(this.db, userId, kind, id);
    if (stored) {
      const verified = this.hmac.verify(stored.capability, { kind, id }, now);
      if (verified.ok) {
        return { capability: verified.token, recovered: false };
      }
      deletePossession(this.db, userId, kind, id);
    }

    const recovered = this.recover(userId, kind, id, now);
    if (recovered) return recovered;
    throw new AuthorizationError(
      capability || stored ? "expired_capability" : "denied",
    );
  }

  /**
   * Present, reuse possession, or recover. Listing uses this so expired
   * favorites/recents stay visible while a containing collection is still
   * readable. This writes possession when recovery mints a token.
   */
  peek(
    userId: string,
    kind: string,
    id: string,
    capability?: string,
    now = Date.now(),
  ): string | null {
    try {
      return this.require(userId, kind, id, capability, now).capability;
    } catch (error) {
      if (error instanceof AuthorizationError) return null;
      throw error;
    }
  }

  private recover(
    userId: string,
    kind: string,
    id: string,
    now: number,
  ): HeldCapability | null {
    for (const collection of this.recovery.collectionsContaining(kind, id)) {
      if (!this.owned.peek(userId, collection.kind, collection.id).read) {
        continue;
      }
      const token = this.hmac.sign(
        kind,
        id,
        recoverySource(collection.kind, collection.id),
        now,
      );
      this.remember(userId, kind, id, token, now);
      return { capability: token, recovered: true };
    }
    return null;
  }
}
