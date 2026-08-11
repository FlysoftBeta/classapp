import { clientBuildId } from "@/client/api/runtime";
import {
  ClientIncidentContext,
  recentRemoteIncidents,
  setDetachedIncidentHandler,
} from "@/client/interact/incidentContext";
import { client } from "@/client/interact/remote/client";
import { session } from "@/client/interact/remote/session";
import { RemoteIncidentError, type IncidentId } from "@/shared/protocol/errors";

const capturedErrors = new WeakMap<object, IncidentId>();
let reportingDepth = 0;

function normalizedError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : String(reason));
}

function linkErrorIncidents(
  context: ClientIncidentContext,
  error: unknown,
): void {
  if (error instanceof RemoteIncidentError) {
    for (const id of error.incidentIds) context.linkIncident(id);
  }
  if (error && typeof error === "object") {
    const existing = capturedErrors.get(error);
    if (existing) context.linkIncident(existing);
  }
}

async function reportClientIncident(
  context: ClientIncidentContext,
  reason: unknown,
): Promise<IncidentId | null> {
  const error = normalizedError(reason);
  const existing = capturedErrors.get(error);
  if (existing) return existing;
  if (reportingDepth > 0 || !client.isConnected()) return null;
  linkErrorIncidents(context, error);
  for (const id of recentRemoteIncidents(context.actorId)) {
    context.linkIncident(id);
  }
  reportingDepth += 1;
  try {
    const result = await client.callInContext(
      context.child("incident.report"),
      "reportClientIncidentAction",
      {
        buildId: clientBuildId(),
        errorName: error.name || "Error",
        message: error.message || String(reason),
        stack: error.stack ?? `${error.name}: ${error.message}`,
        operation: context.label,
        operationId: context.operationId,
        relatedIncidentIds: [...context.relatedIncidentIds()],
      },
    );
    if (!result.ok) return null;
    capturedErrors.set(error, result.data.incidentId);
    context.linkIncident(result.data.incidentId);
    return result.data.incidentId;
  } catch {
    return null;
  } finally {
    reportingDepth -= 1;
  }
}

/** Capture only at an operation boundary; inner layers let panics propagate. */
export async function captureClientOperation<T>(
  label: string,
  run: (context: ClientIncidentContext) => Promise<T>,
): Promise<T> {
  const context = new ClientIncidentContext(
    label,
    session.getUserId(),
    session.getEpoch(),
  );
  try {
    return await run(context);
  } catch (error) {
    linkErrorIncidents(context, error);
    if (!(error instanceof RemoteIncidentError)) {
      await reportClientIncident(context, error);
    }
    throw error;
  }
}

export function captureDetachedClientIncident(
  label: string,
  reason: unknown,
): void {
  const context = new ClientIncidentContext(
    label,
    session.getUserId(),
    session.getEpoch(),
  );
  linkErrorIncidents(context, reason);
  if (reason instanceof RemoteIncidentError) return;
  void reportClientIncident(context, reason);
}

export function installGlobalClientIncidentCapture(): () => void {
  setDetachedIncidentHandler(captureDetachedClientIncident);
  const onError = (event: ErrorEvent) => {
    captureDetachedClientIncident(
      "window.error",
      event.error ?? new Error(event.message),
    );
  };
  const onUnhandled = (event: PromiseRejectionEvent) => {
    captureDetachedClientIncident("window.unhandledrejection", event.reason);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandled);
  return () => {
    setDetachedIncidentHandler(null);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandled);
  };
}
