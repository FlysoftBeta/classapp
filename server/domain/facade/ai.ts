import type { Actor } from "@/server/session/session";
import type { AiService } from "@/server/services/ai/aiService";

export class AiActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly ai: AiService,
  ) {}

  async list() {
    const user = await this.actor.requireFeature("ai");
    return this.ai.list(user);
  }

  async detail(conversationId: string) {
    const user = await this.actor.requireFeature("ai");
    return this.ai.detail(user, conversationId);
  }

  async search(query: string) {
    const user = await this.actor.requireFeature("ai");
    return { conversations: await this.ai.search(user, query) };
  }

  async start(input: {
    conversationId?: string;
    content: string;
    forkFromMessageId?: string;
    images?: Array<{
      name: string;
      mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      data: string;
    }>;
  }) {
    const user = await this.actor.requireFeature("ai");
    return await this.ai.start(user, input);
  }

  async cancel(runId: string) {
    const user = await this.actor.requireFeature("ai");
    return { cancelled: this.ai.cancel(user, runId) };
  }

  async markRead(conversationId: string) {
    const user = await this.actor.requireFeature("ai");
    this.ai.markRead(user, conversationId);
    return { ok: true as const };
  }

  async adminCredits(userId: string) {
    await this.actor.requireAdmin();
    return this.ai.adminCredits(userId);
  }

  async adminTopUp(input: {
    userId: string;
    amount: number;
    idempotencyKey: string;
    note: string;
  }) {
    const admin = await this.actor.requireAdmin();
    return this.ai.adminTopUp({ ...input, adminId: admin.id });
  }
}
