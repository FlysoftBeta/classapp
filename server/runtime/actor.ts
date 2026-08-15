import type { AdminRole } from "@/shared/authority";
import type { Feature } from "@/shared/features";
import type { AuthorityService } from "@/server/services/authorityService";
import type { User } from "@/shared/types/api";

/** The request principal. Business entry points consume this, not raw tokens. */
export class Actor {
  constructor(
    private readonly authority: AuthorityService,
    private readonly authenticatedClientId: string | null,
  ) {}

  user(): User | null {
    return this.authority.user();
  }

  requireUser(): User {
    return this.authority.requireUser();
  }

  requireFeature(feature: Feature): User {
    return this.authority.requireFeature(feature);
  }

  hasRole(role: AdminRole): boolean {
    return this.authority.hasRole(role);
  }

  requireRole(role: AdminRole): User {
    return this.authority.requireRole(role);
  }

  clientId(): string | null {
    return this.authenticatedClientId;
  }

  invalidateFacts(): void {
    this.authority.invalidate();
  }
}
