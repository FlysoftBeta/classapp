import { BUILD_ID } from "@/server/infra/env";
import type { Database } from "better-sqlite3";
import { createIncidentService } from "@/server/services/incidentService";
import { ResultTools, type ActionResult } from "@/shared/protocol/result";

export interface ErrorCaptureContext {
  action?: string;
  requestId?: string;
  userId?: string | null;
  clientBuildId?: string;
  transportEpoch?: number;
}

/** The protocol boundary terminates the failed Action and returns correlation only. */
export class ServerResultCodec {
  static async capture<T>(
    operation: () => Promise<T>,
    context: ErrorCaptureContext,
    db: Database,
  ): Promise<ActionResult<T>> {
    const meta = { buildId: BUILD_ID };
    try {
      return ResultTools.ok(await operation(), meta);
    } catch (error) {
      let captured: { incidentId: string; publicMessage: string };
      try {
        captured = createIncidentService(db, BUILD_ID).capture({
          environment: "server",
          error,
          context: { ...context },
        });
      } catch (captureError) {
        // Incident persistence must never replace the original panic.
        console.error("[Incident] capture failed", captureError);
        console.error("[Incident] original failure", error);
        throw error;
      }
      return ResultTools.err(
        {
          message: captured.publicMessage,
          incidentId: captured.incidentId,
        },
        meta,
      );
    }
  }
}
