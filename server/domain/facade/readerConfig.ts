import type { Actor } from "@/server/session/session";
import type { BlobReaderConfig } from "@/shared/userConfig/reader";
import type { ReaderConfigService } from "@/server/services/readerConfigService";

export class ReaderConfigActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly readerConfig: ReaderConfigService,
  ) {}

  async get(): Promise<BlobReaderConfig> {
    const user = await this.actor.requireFeature("ebook_reader");
    return this.readerConfig.get(user.id);
  }

  async patch(input: Partial<BlobReaderConfig>): Promise<BlobReaderConfig> {
    const user = await this.actor.requireFeature("ebook_reader");
    return this.readerConfig.patch(user.id, input);
  }
}
