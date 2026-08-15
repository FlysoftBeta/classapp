import type { Database } from "better-sqlite3";
import { getUser, getUserBanStatus } from "@/server/data/users";
import { PublicError } from "@/server/services/incidentService";
import { Facts, fact } from "@/server/runtime/facts";
import type { AdminRole } from "@/shared/authority";
import type { Feature } from "@/shared/features";
import type { User } from "@/shared/types/api";

const userFact = fact<User | null>("actor.user");
const bannedFact = fact<boolean>("actor.banned");

/** Request-local identity and authority facts. */
export class AuthorityService {
  private readonly facts = new Facts();

  constructor(
    private readonly db: Database,
    private readonly authenticatedUserId: string | null,
  ) {}

  user(): User | null {
    return this.facts.getOrInit(userFact, () =>
      this.authenticatedUserId
        ? getUser(this.db, this.authenticatedUserId)
        : null,
    );
  }

  requireUser(): User {
    const user = this.user();
    if (!user) throw new PublicError("请先登录");
    const banned = this.facts.getOrInit(
      bannedFact,
      () => getUserBanStatus(this.db, user.id).banned,
    );
    if (banned) throw new PublicError("当前用户已被封禁");
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

  /** Called by request-local mutation paths that changed the current actor. */
  invalidate(): void {
    this.facts.clear();
  }
}
