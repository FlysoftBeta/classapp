import { getDb } from "@/server/infra/db";
import { BUILD_ID } from "@/server/infra/env";
import { createIncidentService } from "@/server/services/incidentService";
import { withActionSession } from "@/server/actions/_base";
import type { ActionInput } from "@/shared/protocol/actions";

export async function reportClientIncidentAction(
  input: ActionInput<"reportClientIncidentAction">,
) {
  return withActionSession(async (session) => {
    const error = new Error(input.message);
    error.name = input.errorName;
    error.stack = input.stack;
    const captured = createIncidentService(getDb(), BUILD_ID).capture({
      environment: "client",
      buildId: input.buildId,
      error,
      relatedIncidentIds: input.relatedIncidentIds,
      context: {
        operation: input.operation,
        operation_id: input.operationId,
        user_id: await session.identity(),
        client_id: await session.clientId(),
      },
    });
    return { incidentId: captured.incidentId };
  });
}

export async function adminFetchIncidentGroupsAction(
  input?: ActionInput<"adminFetchIncidentGroupsAction">,
) {
  return withActionSession(async (session) => {
    await (await session.asActor()).requireAdmin();
    return {
      groups: createIncidentService(getDb(), BUILD_ID).list(input ?? {}),
    };
  });
}

export async function adminFetchIncidentDetailsAction(
  groupId: ActionInput<"adminFetchIncidentDetailsAction">,
) {
  return withActionSession(async (session) => {
    await (await session.asActor()).requireAdmin();
    return {
      incidents: createIncidentService(getDb(), BUILD_ID).details(groupId),
    };
  });
}

export async function adminTestIncidentAction() {
  return withActionSession(async (session) => {
    await (await session.asActor()).requireAdmin();
    throw new Error("Manual server Incident test");
  });
}
