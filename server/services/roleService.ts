import type { Database } from "better-sqlite3";
import {
  ADMIN_ROLES,
  roleDependencies,
  type AdminRole,
} from "@/shared/authority";
import {
  countUsersWithRole,
  listUserRoles,
  replaceUserRoles,
} from "@/server/data/roles";
import { userExists } from "@/server/data/users";
import { PublicError } from "@/server/services/incidentService";

function normalizeRoles(roles: readonly AdminRole[]): AdminRole[] {
  return ADMIN_ROLES.filter((role) => roles.includes(role));
}

export class RoleService {
  constructor(private readonly db: Database) {}

  roles(userId: string): AdminRole[] {
    return listUserRoles(this.db, userId);
  }

  replace(
    userId: string,
    roles: readonly AdminRole[],
    grantedBy: string,
  ): AdminRole[] {
    if (!userExists(this.db, userId)) throw new PublicError("干员不存在");
    const normalized = normalizeRoles(roles);
    for (const role of normalized) {
      for (const dependency of roleDependencies(role)) {
        if (!normalized.includes(dependency)) {
          throw new PublicError("管理员角色缺少前置角色");
        }
      }
    }
    const current = this.roles(userId);
    if (
      current.includes("root") &&
      !normalized.includes("root") &&
      countUsersWithRole(this.db, "root") <= 1
    ) {
      throw new PublicError("不能移除最后一个根管理员");
    }
    this.db.transaction(() => {
      replaceUserRoles(this.db, { userId, roles: normalized, grantedBy });
    })();
    return this.roles(userId);
  }

  assertRemovable(userId: string): void {
    if (
      this.roles(userId).includes("root") &&
      countUsersWithRole(this.db, "root") <= 1
    ) {
      throw new PublicError("不能删除或注销最后一个根管理员");
    }
  }
}

export function createRoleService(db: Database): RoleService {
  return new RoleService(db);
}
