import type { Actor } from "@/server/runtime/actor";
import type { AuditService } from "@/server/services/auditService";

export class AuditActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly audit: AuditService,
  ) {}

  list(offset: number) {
    this.actor.requireRole("root");
    return this.audit.list(offset);
  }
}
