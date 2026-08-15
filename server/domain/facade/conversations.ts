import type {
  ConversationEntity,
  UserMetadata,
} from "@/shared/types/api";
import type {
  ConversationRefInput,
  ConversationService,
} from "@/server/services/conversationsService";
import type { Actor } from "@/server/runtime/actor";

export class ConversationActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly conversations: ConversationService,
  ) {}

  async list(): Promise<{
    entries: ConversationEntity[];
    users: UserMetadata[];
  }> {
    const user = await this.actor.requireUser();
    return this.conversations.list(user.id);
  }

  async revisions(): Promise<
    Array<{ conv_id: string; revision: number; revision_sum: string }>
  > {
    const user = await this.actor.requireUser();
    return this.conversations.revisions(user.id);
  }

  async markRead(
    input: ConversationRefInput & {
      postId: string;
      updatedAt: number;
      merge: "override" | "furthest";
    },
  ): Promise<{ postId: string | null; sequence: number; updatedAt: number }> {
    const user = await this.actor.requireUser();
    return this.conversations.markRead(user.id, input);
  }

  async setPinned(
    input: ConversationRefInput & { pinned: boolean; updatedAt: number },
  ): Promise<{ value: boolean; updatedAt: number }> {
    const user = await this.actor.requireUser();
    return this.conversations.setPinned(user.id, input);
  }

  async setMuted(
    input: ConversationRefInput & { muted: boolean; updatedAt: number },
  ): Promise<{ value: boolean; updatedAt: number }> {
    const user = await this.actor.requireUser();
    return this.conversations.setMuted(user.id, input);
  }

  async getDraft(
    input: ConversationRefInput,
  ): Promise<{ draft: string; updatedAt: number }> {
    const user = await this.actor.requireUser();
    return this.conversations.getDraft(user.id, input);
  }

  async saveDraft(
    input: ConversationRefInput & { draft: string; updatedAt: number },
  ): Promise<{ draft: string; updatedAt: number }> {
    const user = await this.actor.requireUser();
    return this.conversations.saveDraft(user.id, input);
  }
}

export type { ConversationRefInput };
