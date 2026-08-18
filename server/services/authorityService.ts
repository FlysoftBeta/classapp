import type { Database } from "better-sqlite3";
import { PublicError } from "@/server/services/incidentService";
import { getUser, getUserBanStatus } from "@/server/data/users";
import type { AdminRole } from "@/shared/authority";
import type { Feature } from "@/shared/features";
import type { User } from "@/shared/types/api";

/** Request principal reads. Isolation comes from the connection snapshot, not a Fact cache. */
export class AuthorityService {
  constructor(
    private readonly db: Database,
    private readonly authenticatedUserId: string | null,
  ) {}

  user(): User | null {
    return this.authenticatedUserId
      ? getUser(this.db, this.authenticatedUserId)
      : null;
  }

  requireUser(): User {
    const user = this.user();
    if (!user) throw new PublicError("请先登录");
    if (getUserBanStatus(this.db, user.id).banned) {
      throw new PublicError("当前用户已被封禁");
    }
    return user;
  }

  requireFeature(feature: Feature): User {
    const user = this.requireUser();
    if (!user.features[feature]) throw new PublicError("无权限");
    return user;
  }

  hasRole(role: AdminRole): boolean {
    return this.user()?.administration.roles.includes(role) === true;
  }

  requireRole(role: AdminRole): User {
    const user = this.requireUser();
    if (!user.administration.roles.includes(role)) {
      throw new PublicError("无权限");
    }
    return user;
  }
}
