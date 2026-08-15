import type { Actor } from "@/server/runtime/actor";
import type { StickerService } from "@/server/services/stickerService";

export class StickerActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly stickers: StickerService,
  ) {}

  listPacks() {
    return this.stickers.listPacks();
  }

  getPack(packId: string) {
    return this.stickers.getPack(packId);
  }

  async getRecent() {
    const user = await this.actor.requireUser();
    return this.stickers.getRecent(user.id);
  }

  async touchRecent(pack: string, stickerId: string) {
    const user = await this.actor.requireUser();
    return this.stickers.touchRecent(user.id, pack, stickerId);
  }
}
