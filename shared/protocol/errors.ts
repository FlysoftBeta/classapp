import { z } from "zod";

export const incidentIdSchema = z.string().regex(/^I_[A-Za-z0-9_-]{22}$/);
export type IncidentId = z.infer<typeof incidentIdSchema>;

/** Transport-level panic correlation; this is not an Action domain Failure. */
export const incidentPanicSchema = z
  .object({
    message: z.string(),
    incidentId: incidentIdSchema,
  })
  .strict();
export type IncidentPanicData = z.infer<typeof incidentPanicSchema>;

/** A server failure is terminal for the Action; clients only retain correlation. */
export class RemoteIncidentError extends Error {
  readonly incidentIds: readonly IncidentId[];
  readonly publicMessage: string;

  constructor(message: string, incidentIds: readonly IncidentId[]) {
    const unique = [...new Set(incidentIds)];
    super(`${message}（Incident ID: ${unique.join(", ")}）`);
    this.name = "RemoteIncidentError";
    this.publicMessage = message;
    this.incidentIds = unique;
  }
}
