import type { Actor } from "@/server/runtime/actor";
import type { AiService } from "@/server/services/ai/aiService";
import type { AiBillingService } from "@/server/services/ai/aiBillingService";
import type { AuditService } from "@/server/services/auditService";
import type { UnitOfWork } from "@/server/runtime/unitOfWork";
import { PublicError } from "@/server/services/incidentService";

export class AiActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly ai: AiService,
    private readonly billing: AiBillingService,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
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
    this.actor.requireRole("feature_manager");
    return this.billing.account(userId);
  }

  adminBillingSummary() {
    this.actor.requireRole("feature_manager");
    return this.billing.summary();
  }

  adminUpdateBillingPolicy(input: {
    dailyAllowance: number;
    weeklyAllowance: number;
    defaultPlanDurationDays: number;
  }) {
    const admin = this.actor.requireRole("feature_manager");
    return this.unitOfWork.run(() => {
      const policy = this.billing.updatePolicy({
        ...input,
        adminId: admin.id,
      });
      this.audit.record({
        actorId: admin.id,
        action: "ai.billing_policy.update",
        targetKind: "runtime-policy",
        details: input,
      });
      return policy;
    });
  }

  adminAssignCredits(input: {
    targets: Array<{ userId: string; idempotencyKey: string }>;
    durationDays?: number;
    amount?: number;
    note: string;
  }) {
    const admin = this.actor.requireRole("feature_manager");
    const userIds = new Set<string>();
    for (const target of input.targets) {
      if (userIds.has(target.userId)) throw new PublicError("请求包含重复干员");
      userIds.add(target.userId);
    }
    return this.unitOfWork.run(() => {
      for (const { userId, idempotencyKey } of input.targets) {
        if (input.durationDays !== undefined) {
          this.billing.assignPlan({
            userId,
            durationDays: input.durationDays,
            adminId: admin.id,
          });
        }
        if (input.amount !== undefined) {
          this.billing.topUp({
            userId,
            amount: input.amount,
            adminId: admin.id,
            idempotencyKey,
            note: input.note,
          });
        }
      }
      this.audit.record({
        actorId: admin.id,
        action: "ai.credits.batch_assign",
        targetKind: "user-set",
        details: {
          user_ids: [...userIds],
          duration_days: input.durationDays,
          amount: input.amount,
          note: input.note,
        },
      });
      return { ok: true as const };
    });
  }
}
