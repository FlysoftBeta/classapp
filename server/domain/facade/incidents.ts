import type { Actor } from "@/server/runtime/actor";
import type { RequestIdentity } from "@/server/runtime/scope";
import type { IncidentService } from "@/server/services/incidentService";
import type { IncidentLogArchiveService } from "@/server/services/incidentLogArchiveService";

export class IncidentFacade {
  constructor(
    private readonly actor: Actor,
    private readonly identity: RequestIdentity,
    private readonly incidents: IncidentService,
    private readonly logs: IncidentLogArchiveService,
  ) {}

  reportClient(input: {
    message: string;
    errorName: string;
    stack?: string;
    buildId: string;
    relatedIncidentIds: string[];
    operation: string;
    operationId: string;
  }) {
    const error = new Error(input.message);
    error.name = input.errorName;
    error.stack = input.stack;
    const captured = this.incidents.capture({
      environment: "client",
      buildId: input.buildId,
      error,
      relatedIncidentIds: input.relatedIncidentIds,
      context: {
        operation: input.operation,
        operation_id: input.operationId,
        user_id: this.identity.userId,
        client_id: this.identity.clientId,
      },
    });
    return { incidentId: captured.incidentId };
  }

  list(input: { environment?: "server" | "client"; buildId?: string }) {
    this.actor.requireRole("operations");
    return { groups: this.incidents.list(input) };
  }

  details(groupId: number) {
    this.actor.requireRole("operations");
    return { incidents: this.incidents.details(groupId) };
  }

  test(): never {
    this.actor.requireRole("operations");
    throw new Error("Manual server Incident test");
  }

  downloadLogs() {
    this.actor.requireRole("operations");
    return this.logs.build();
  }
}
