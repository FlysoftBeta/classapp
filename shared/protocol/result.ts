import { z } from "zod";
import {
  actionErrorSchema,
  errorFromData,
  type ActionErrorData,
  type CheckedError,
  type UncheckedError,
} from "@/shared/protocol/errors";

export const actionMetaSchema = z
  .object({
    buildId: z.string(),
  })
  .strict();
export type ActionMeta = z.infer<typeof actionMetaSchema>;

export type ActionResult<T> =
  | { ok: true; data: T; meta: ActionMeta }
  | { ok: false; error: ActionErrorData; meta: ActionMeta };

/** Client-visible Result: unchecked errors are unpacked as panic-like throws. */
export type CheckedActionResult<T> =
  | { ok: true; data: T; meta: ActionMeta }
  | {
      ok: false;
      error: Extract<ActionErrorData, { kind: "checked" }>;
      meta: ActionMeta;
    };

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
        error: actionErrorSchema,
        meta: actionMetaSchema,
      })
      .strict(),
  ]);
}

/** Result construction and transparent wire error reconstruction. */
export class ResultTools {
  static ok<T>(data: T, meta: ActionMeta): ActionResult<T> {
    return { ok: true, data, meta };
  }

  static err<T = never>(
    error: ActionErrorData,
    meta: ActionMeta,
  ): ActionResult<T> {
    return { ok: false, error, meta };
  }

  static unwrap<T>(result: ActionResult<T>): T {
    if (result.ok) return result.data;
    throw errorFromData(result.error);
  }

  static error(
    result: ActionResult<unknown>,
  ): CheckedError | UncheckedError | null {
    return result.ok ? null : errorFromData(result.error);
  }
}
