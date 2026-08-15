import type { Actor } from "@/server/runtime/actor";
import type { GhostUserService } from "@/server/services/ghostUsersService";
import type { AuditService } from "@/server/services/auditService";

export class GhostUserActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly ghostUsers: GhostUserService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    this.actor.requireRole("access_manager");
    return this.ghostUsers.list();
  }

  async create(): Promise<{ pin: string; ghost_id: string }> {
    const admin = this.actor.requireRole("access_manager");
    const ghost = this.ghostUsers.create();
    this.audit.record({
      actorId: admin.id,
      action: "ghost_user.create",
      targetKind: "ghost-user",
      targetId: ghost.ghost_id,
    });
    return ghost;
  }

  async delete(id: string): Promise<void> {
    const admin = this.actor.requireRole("access_manager");
    this.ghostUsers.delete(id);
    this.audit.record({
      actorId: admin.id,
      action: "ghost_user.delete",
      targetKind: "ghost-user",
      targetId: id,
    });
  }
}
