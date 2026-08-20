import type { Database } from "better-sqlite3";
import {
  EMPTY_ACCESS_FLAGS,
  capabilitySourceId,
  capabilitySourceKind,
  flagsSatisfy,
  mergeIncomingGrant,
  recoverySource,
  unionFlagList,
  type AccessFlags,
  type AccessGrant,
  type AccessNeed,
  type CapabilitySource,
  type PrincipalRef,
} from "@/shared/access";
import {
  deleteAccessBinding,
  deleteBindingsForPrincipal,
  deleteBindingsForResource,
  deleteEffectiveAccess,
  deletePossession,
  listBindingsForPrincipal,
  listBindingsForResource,
  listFavoriteIds,
  listReadableResourceIds,
  listRecentIds,
  readEffectiveAccess,
  readPossession,
  upsertAccessBinding,
  upsertEffectiveAccess,
  upsertFavorite,
  upsertPossession,
  touchRecent,
  principalExists,
  type EffectiveAccessRow,
} from "@/server/data/access";
import { listGroupMemberIds, listUserGroupIds } from "@/server/data/groups";
import { AuthorizationError } from "@/server/services/authorizationError";
import { CapabilityService } from "@/server/services/capabilityService";

export interface OwnedAuthorization {
  flags: AccessFlags;
  recovered: boolean;
  provenance: EffectiveAccessRow["provenance"];
}

export interface OwnerlessAuthorization {
  capability: string;
  recovered: boolean;
}

/** A still-readable owned collection that contains an ownerless object. */
export interface ContainingCollection {
  kind: string;
  id: string;
  revision?: number;
}

/**
 * Domain port: find collections that currently contain an ownerless object.
 * AccessService then checks whether the current user can still read them.
 * Implementations live in media/articles data; this module does not query
 * playlist or booklist tables.
 */
export interface OwnerlessRecovery {
  collectionsContaining(
    objectKind: string,
    objectId: string,
  ): ContainingCollection[];
}

export type FavoriteAccessClass = "owned" | "ownerless";

const EMPTY_RECOVERY: OwnerlessRecovery = {
  collectionsContaining: () => [],
};

export class AccessService {
  constructor(
    private readonly db: Database,
    private readonly capabilities: CapabilityService,
    private readonly recovery: OwnerlessRecovery = EMPTY_RECOVERY,
  ) {}

  liveFlags(
    userId: string,
    resourceKind: string,
    resourceId: string,
  ): { flags: AccessFlags; provenance: EffectiveAccessRow["provenance"] } {
    const groupIds = listUserGroupIds(this.db, userId);
    const bindings = listBindingsForResource(this.db, resourceKind, resourceId);
    const contributing = bindings.filter(
      (binding) =>
        (binding.principal.kind === "user" && binding.principal.id === userId) ||
        (binding.principal.kind === "group" &&
          groupIds.indexOf(binding.principal.id) !== -1),
    );
    return {
      flags: unionFlagList(contributing.map((binding) => binding.flags)),
      provenance: contributing,
    };
  }

  /**
   * Write the effective row from live bindings. Call after grant, revoke,
   * membership change, or when a materialized check misses.
   */
  rematerialize(
    userId: string,
    resourceKind: string,
    resourceId: string,
  ): AccessFlags {
    const { flags, provenance } = this.liveFlags(
      userId,
      resourceKind,
      resourceId,
    );
    if (!flags.read) {
      deleteEffectiveAccess(this.db, userId, resourceKind, resourceId);
      return EMPTY_ACCESS_FLAGS;
    }
    upsertEffectiveAccess(this.db, {
      userId,
      resourceKind,
      resourceId,
      flags,
      provenance: provenance.map((entry) => ({
        principal: entry.principal,
        grants: entry.grants,
      })),
    });
    return flags;
  }

  rematerializeResource(resourceKind: string, resourceId: string): void {
    const bindings = listBindingsForResource(this.db, resourceKind, resourceId);
    const users = new Set<string>();
    for (const binding of bindings) {
      if (binding.principal.kind === "user") users.add(binding.principal.id);
      else {
        for (const memberId of listGroupMemberIds(this.db, binding.principal.id)) {
          users.add(memberId);
        }
      }
    }
    const previously = this.db
      .prepare(
        `SELECT user_id FROM access_effective
          WHERE resource_kind = ? AND resource_id = ?`,
      )
      .all(resourceKind, resourceId) as Array<{ user_id: string }>;
    for (const row of previously) users.add(row.user_id);
    for (const userId of users) {
      this.rematerialize(userId, resourceKind, resourceId);
    }
  }

  onGroupMembershipChanged(userId: string, groupId: string): void {
    const bindings = listBindingsForPrincipal(this.db, {
      kind: "group",
      id: groupId,
    });
    for (const binding of bindings) {
      this.rematerialize(userId, binding.resourceKind, binding.resourceId);
    }
  }

  onGroupDeleted(groupId: string): void {
    const bindings = listBindingsForPrincipal(this.db, {
      kind: "group",
      id: groupId,
    });
    const affected = bindings.map((binding) => ({
      kind: binding.resourceKind,
      id: binding.resourceId,
    }));
    deleteBindingsForPrincipal(this.db, { kind: "group", id: groupId });
    for (const resource of affected) {
      this.rematerializeResource(resource.kind, resource.id);
    }
  }

  onUserPurged(userId: string): void {
    const bindings = listBindingsForPrincipal(this.db, {
      kind: "user",
      id: userId,
    });
    deleteBindingsForPrincipal(this.db, { kind: "user", id: userId });
    for (const binding of bindings) {
      this.rematerializeResource(binding.resourceKind, binding.resourceId);
    }
  }

  /**
   * Happy path reads the materialized row. On miss or stale denial, recompute
   * from live bindings and retry so the UI does not have to rediscover a path.
   */
  authorizeOwned(
    userId: string,
    resourceKind: string,
    resourceId: string,
    need: AccessNeed,
  ): OwnedAuthorization {
    const materialized = readEffectiveAccess(
      this.db,
      userId,
      resourceKind,
      resourceId,
    );
    if (materialized && flagsSatisfy(materialized.flags, need)) {
      return {
        flags: materialized.flags,
        recovered: false,
        provenance: materialized.provenance,
      };
    }
    const flags = this.rematerialize(userId, resourceKind, resourceId);
    const live = readEffectiveAccess(this.db, userId, resourceKind, resourceId);
    if (flagsSatisfy(flags, need) && live) {
      return { flags, recovered: true, provenance: live.provenance };
    }
    throw new AuthorizationError("denied");
  }

  peekOwned(
    userId: string,
    resourceKind: string,
    resourceId: string,
  ): AccessFlags {
    const materialized = readEffectiveAccess(
      this.db,
      userId,
      resourceKind,
      resourceId,
    );
    if (materialized) return materialized.flags;
    return this.rematerialize(userId, resourceKind, resourceId);
  }

  grant(
    actorId: string,
    resourceKind: string,
    resourceId: string,
    principal: PrincipalRef,
    grant: AccessGrant,
  ): AccessFlags {
    this.authorizeOwned(actorId, resourceKind, resourceId, { share: grant });
    this.requirePrincipal(principal);
    const existing = listBindingsForResource(
      this.db,
      resourceKind,
      resourceId,
    ).find(
      (binding) =>
        binding.principal.kind === principal.kind &&
        binding.principal.id === principal.id,
    );
    upsertAccessBinding(
      this.db,
      resourceKind,
      resourceId,
      principal,
      mergeIncomingGrant(existing?.grants ?? [], grant),
    );
    this.rematerializeResource(resourceKind, resourceId);
    return this.peekOwned(actorId, resourceKind, resourceId);
  }

  private requirePrincipal(principal: PrincipalRef): void {
    if (!principalExists(this.db, principal)) {
      throw new AuthorizationError("not_found");
    }
  }

  revoke(
    actorId: string,
    resourceKind: string,
    resourceId: string,
    principal: PrincipalRef,
  ): void {
    this.authorizeOwned(actorId, resourceKind, resourceId, "own");
    if (principal.kind === "user" && principal.id === actorId) {
      throw new AuthorizationError("denied");
    }
    deleteAccessBinding(this.db, resourceKind, resourceId, principal);
    this.rematerializeResource(resourceKind, resourceId);
  }

  bindOwner(
    resourceKind: string,
    resourceId: string,
    principal: PrincipalRef,
  ): void {
    upsertAccessBinding(this.db, resourceKind, resourceId, principal, [
      { mode: "owner" },
    ]);
    this.rematerializeResource(resourceKind, resourceId);
  }

  dropResource(resourceKind: string, resourceId: string): void {
    deleteBindingsForResource(this.db, resourceKind, resourceId);
  }

  listAccessibleIds(userId: string, resourceKind: string): string[] {
    return listReadableResourceIds(this.db, userId, resourceKind);
  }

  listBindings(resourceKind: string, resourceId: string) {
    return listBindingsForResource(this.db, resourceKind, resourceId);
  }

  signOwnerless(
    kind: string,
    id: string,
    source: CapabilitySource,
    now = Date.now(),
  ): string {
    return this.capabilities.sign(kind, id, source, now);
  }

  rememberPossession(
    userId: string,
    kind: string,
    id: string,
    capability: string,
    now = Date.now(),
  ): void {
    const verified = this.capabilities.verify(capability, { kind, id }, now);
    if (!verified.ok) return;
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

  authorizeOwnerless(
    userId: string,
    kind: string,
    id: string,
    capability: string | undefined,
    now = Date.now(),
  ): OwnerlessAuthorization {
    if (capability) {
      const presented = this.capabilities.verify(
        capability,
        { kind, id },
        now,
      );
      if (presented.ok) {
        this.rememberPossession(userId, kind, id, presented.token, now);
        return { capability: presented.token, recovered: false };
      }
      if (
        presented.reason === "kind_mismatch" ||
        presented.reason === "id_mismatch" ||
        presented.reason === "invalid"
      ) {
        const recovered = this.recoverOwnerless(userId, kind, id, now);
        if (recovered) return recovered;
        throw new AuthorizationError("invalid_capability");
      }
    }

    const stored = readPossession(this.db, userId, kind, id);
    if (stored) {
      const verified = this.capabilities.verify(
        stored.capability,
        { kind, id },
        now,
      );
      if (verified.ok) {
        return { capability: verified.token, recovered: false };
      }
      deletePossession(this.db, userId, kind, id);
    }

    const recovered = this.recoverOwnerless(userId, kind, id, now);
    if (recovered) return recovered;
    throw new AuthorizationError(
      capability || stored ? "expired_capability" : "denied",
    );
  }

  /** Authorize without throwing; used when assembling library aggregations. */
  presentOwnerless(
    userId: string,
    kind: string,
    id: string,
    capability?: string,
    now = Date.now(),
  ): string | null {
    try {
      return this.authorizeOwnerless(userId, kind, id, capability, now)
        .capability;
    } catch (error) {
      if (error instanceof AuthorizationError) return null;
      throw error;
    }
  }

  private recoverOwnerless(
    userId: string,
    kind: string,
    id: string,
    now: number,
  ): OwnerlessAuthorization | null {
    const containing = this.findReadableContainingCollection(userId, kind, id);
    if (!containing) return null;
    const token = this.capabilities.sign(
      kind,
      id,
      recoverySource(containing.kind, containing.id),
      now,
    );
    this.rememberPossession(userId, kind, id, token, now);
    return { capability: token, recovered: true };
  }

  private findReadableContainingCollection(
    userId: string,
    kind: string,
    id: string,
  ): ContainingCollection | null {
    for (const collection of this.recovery.collectionsContaining(kind, id)) {
      const flags = this.rematerialize(userId, collection.kind, collection.id);
      if (flags.read) return collection;
    }
    return null;
  }

  favorite(
    userId: string,
    resourceKind: string,
    resourceId: string,
    favorited: boolean,
    updatedAtMs: number,
    accessClass: FavoriteAccessClass,
    capability?: string,
  ): { value: boolean; updatedAt: number } {
    if (accessClass === "owned") {
      this.authorizeOwned(userId, resourceKind, resourceId, "read");
    } else {
      this.authorizeOwnerless(userId, resourceKind, resourceId, capability);
    }
    return upsertFavorite(
      this.db,
      userId,
      resourceKind,
      resourceId,
      favorited,
      updatedAtMs,
    );
  }

  recordRecent(userId: string, resourceKind: string, resourceId: string): void {
    touchRecent(this.db, userId, resourceKind, resourceId);
  }

  listFavorites(
    userId: string,
    resourceKind: string,
    accessClass: FavoriteAccessClass,
  ): string[] {
    return listFavoriteIds(this.db, userId, resourceKind).filter((id) =>
      this.stillReachable(userId, resourceKind, id, accessClass),
    );
  }

  listRecents(
    userId: string,
    resourceKind: string,
    accessClass: FavoriteAccessClass,
    limit = 50,
  ): string[] {
    return listRecentIds(this.db, userId, resourceKind, limit).filter((id) =>
      this.stillReachable(userId, resourceKind, id, accessClass),
    );
  }

  private stillReachable(
    userId: string,
    resourceKind: string,
    id: string,
    accessClass: FavoriteAccessClass,
  ): boolean {
    try {
      if (accessClass === "owned") {
        this.authorizeOwned(userId, resourceKind, id, "read");
      } else {
        this.authorizeOwnerless(userId, resourceKind, id, undefined);
      }
      return true;
    } catch (error) {
      if (error instanceof AuthorizationError) return false;
      throw error;
    }
  }
}

export function createAccessService(
  db: Database,
  capabilities: CapabilityService,
  recovery?: OwnerlessRecovery,
): AccessService {
  return new AccessService(db, capabilities, recovery);
}
