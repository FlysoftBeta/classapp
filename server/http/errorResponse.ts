import { BUILD_ID } from "@/server/infra/env";
import {
  createIncidentService,
  PublicError,
} from "@/server/services/incidentService";
import { currentScope } from "@/server/runtime/scope";

export { PublicError };

/** Raw HTTP is a containment boundary, never a source of domain status codes. */
export function handleHttpError(error: unknown): Response {
  let captured: { publicMessage: string; incidentId: string };
  try {
    captured = createIncidentService(currentScope().db, BUILD_ID).capture({
      environment: "server",
      error,
      context: { transport: "http" },
    });
  } catch (captureError) {
    console.error("[Incident] HTTP capture failed", captureError);
    console.error("[Incident] original HTTP failure", error);
    throw error;
  }
  return Response.json(
    {
      error: captured.publicMessage,
      incidentId: captured.incidentId,
    },
    { status: 500 },
  );
}
