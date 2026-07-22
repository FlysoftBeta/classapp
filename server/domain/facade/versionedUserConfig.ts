import type { Actor } from "@/server/session/session";
import type { VersionedUserConfigService } from "@/server/services/versionedUserConfigService";

export class VersionedUserConfigActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly service: VersionedUserConfigService,
  ) {}
  async get(keys: string[]) {
    return this.service.get((await this.actor.requireUser()).id, keys);
  }
  async set(key: string, value: string, updatedAt: number) {
    return this.service.set(
      (await this.actor.requireUser()).id,
      key,
      value,
      updatedAt,
    );
  }
}
