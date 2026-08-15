import type { Actor } from "@/server/runtime/actor";
import type { AnnouncementService } from "@/server/services/announcementService";

export class AnnouncementActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly service: AnnouncementService,
  ) {}
  async get() {
    return this.service.getForUser((await this.actor.requireUser()).id);
  }
  async acknowledge(revision: number) {
    return {
      ok: true as const,
      acknowledged: this.service.acknowledge(
        (await this.actor.requireUser()).id,
        revision,
      ),
    };
  }
}
