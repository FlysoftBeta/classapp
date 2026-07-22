import type { Actor } from "@/server/session/session";
import type { GhostUserService } from "@/server/services/ghostUsersService";

export class GhostUserActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly ghostUsers: GhostUserService,
  ) {}

  async list() {
    await this.actor.requireAdmin();
    return this.ghostUsers.list();
  }

  async create(): Promise<{ pin: string; ghost_id: string }> {
    await this.actor.requireAdmin();
    return this.ghostUsers.create();
  }

  async delete(id: string): Promise<void> {
    await this.actor.requireAdmin();
    this.ghostUsers.delete(id);
  }
}
