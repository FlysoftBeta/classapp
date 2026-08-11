import { z } from "zod";
import {
  incidentPanicSchema,
  RemoteIncidentError,
  type IncidentPanicData,
} from "@/shared/protocol/errors";

export const actionMetaSchema = z
  .object({
    buildId: z.string(),
  })
  .strict();
export type ActionMeta = z.infer<typeof actionMetaSchema>;

export type ActionResult<T> =
  | { ok: true; data: T; meta: ActionMeta }
  | { ok: false; error: IncidentPanicData; meta: ActionMeta };

export function actionResultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z
      .object({
        ok: z.literal(true),
        data,
        meta: actionMetaSchema,
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        error: incidentPanicSchema,
        meta: actionMetaSchema,
      })
      .strict(),
  ]);
}

export class ResultTools {
  static ok<T>(data: T, meta: ActionMeta): ActionResult<T> {
    return { ok: true, data, meta };
  }

  static err<T = never>(
    error: IncidentPanicData,
    meta: ActionMeta,
  ): ActionResult<T> {
    return { ok: false, error, meta };
  }

  static unwrap<T>(result: ActionResult<T>): T {
    if (result.ok) return result.data;
    throw new RemoteIncidentError(result.error.message, [
      result.error.incidentId,
    ]);
  }
}
