import type { Database } from "better-sqlite3";
import {
  EMPTY_ACCESS_FLAGS,
  flagsSatisfy,
  mergeIncomingGrant,
  unionFlagList,
  type AccessFlags,
  type AccessGrant,
  type AccessNeed,
  type PrincipalRef,
} from "@/shared/access";
import {
  deleteAccessBinding,
  deleteBindingsForPrincipal,
  deleteBindingsForResource,
  deleteEffectiveAccess,
  listBindingsForPrincipal,
  listBindingsForResource,
  listReadableResourceIds,
  readEffectiveAccess,
  upsertAccessBinding,
  upsertEffectiveAccess,
  principalExists,
  type EffectiveAccessRow,
} from "@/server/data/access";
import { listGroupMemberIds, listUserGroupIds } from "@/server/data/groups";
import { AuthorizationError } from "@/server/services/authorizationError";

export interface OwnedAuthorization {
  flags: AccessFlags;
  recovered: boolean;
  provenance: EffectiveAccessRow["provenance"];
}

/**
 * Owned-resource access: principal×resource bindings and materialized flags.
 * Ownerless objects (tracks, articles) have no bindings; they use capabilities.
 */
export class AccessService {
  constructor(private readonly db: Database) {}

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

  onGroupMembershipChanged(
    userId: string,
    groupId: string,
    groupDeleted = false,
  ): void {
    const bindings = listBindingsForPrincipal(this.db, {
      kind: "group",
      id: groupId,
    });
    for (const binding of bindings) {
      this.rematerialize(userId, binding.resourceKind, binding.resourceId);
    }
    if (groupDeleted) this.onGroupDeleted(groupId);
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
  authorize(
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

  peek(
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
    this.authorize(actorId, resourceKind, resourceId, { share: grant });
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
    return this.peek(actorId, resourceKind, resourceId);
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
    this.authorize(actorId, resourceKind, resourceId, "own");
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
}

export function createAccessService(db: Database): AccessService {
  return new AccessService(db);
}
