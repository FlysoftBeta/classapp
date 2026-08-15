import type { Actor } from "@/server/runtime/actor";
import type { AiService } from "@/server/services/ai/aiService";
import type { AiBillingService } from "@/server/services/ai/aiBillingService";
import type { AuditService } from "@/server/services/auditService";
import type { UnitOfWork } from "@/server/runtime/unitOfWork";

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

  async adminTopUp(input: {
    userId: string;
    amount: number;
    idempotencyKey: string;
    note: string;
  }) {
    const admin = this.actor.requireRole("feature_manager");
    return this.unitOfWork.run(() => {
      const credits = this.billing.topUp({ ...input, adminId: admin.id });
      this.audit.record({
        actorId: admin.id,
        action: "ai.top_up",
        targetKind: "user",
        targetId: input.userId,
        details: { amount: input.amount, note: input.note },
      });
      return credits;
    });
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

  adminAssignPlan(input: { userId: string; durationDays: number }) {
    const admin = this.actor.requireRole("feature_manager");
    return this.unitOfWork.run(() => {
      const credits = this.billing.assignPlan({
        ...input,
        adminId: admin.id,
      });
      this.audit.record({
        actorId: admin.id,
        action: "ai.plan.assign",
        targetKind: "user",
        targetId: input.userId,
        details: { duration_days: input.durationDays },
      });
      return credits;
    });
  }
}
