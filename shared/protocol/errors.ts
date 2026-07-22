import { z } from "zod";

export const checkedErrorCodeSchema = z.enum([
  "SESSION_EXPIRED",
  "AUTHENTICATION_FAILED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "THROTTLED",
]);
export type CheckedErrorCode = z.infer<typeof checkedErrorCodeSchema>;

export const uncheckedErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "INTERNAL_SERVER_ERROR",
]);
export type UncheckedErrorCode = z.infer<typeof uncheckedErrorCodeSchema>;

export const checkedErrorSchema = z
  .object({
    kind: z.literal("checked"),
    code: checkedErrorCodeSchema,
    message: z.string(),
    status: z.number().int(),
    tokenExpired: z.boolean().optional(),
  })
  .strict();

export const uncheckedErrorSchema = z
  .object({
    kind: z.literal("unchecked"),
    code: uncheckedErrorCodeSchema,
    message: z.string(),
    issues: z.array(z.unknown()).optional(),
  })
  .strict();

export const actionErrorSchema = z.discriminatedUnion("kind", [
  checkedErrorSchema,
  uncheckedErrorSchema,
]);

export type CheckedErrorData = z.infer<typeof checkedErrorSchema>;
export type UncheckedErrorData = z.infer<typeof uncheckedErrorSchema>;
export type ActionErrorData = z.infer<typeof actionErrorSchema>;

export class CheckedError extends Error {
  readonly kind = "checked" as const;

  constructor(
    readonly code: CheckedErrorCode,
    message: string,
    readonly status: number,
    readonly tokenExpired = false,
  ) {
    super(message);
    this.name = "CheckedError";
  }

  static fromData(data: CheckedErrorData): CheckedError {
    return new CheckedError(
      data.code,
      data.message,
      data.status,
      data.tokenExpired === true,
    );
  }

  toData(): CheckedErrorData {
    return {
      kind: this.kind,
      code: this.code,
      message: this.message,
      status: this.status,
      tokenExpired: this.tokenExpired || undefined,
    };
  }
}

export class UncheckedError extends Error {
  readonly kind = "unchecked" as const;

  constructor(
    readonly code: UncheckedErrorCode,
    message: string,
    readonly issues?: unknown[],
  ) {
    super(message);
    this.name = "UncheckedError";
  }

  static badRequest(
    message = "请求格式错误",
    issues?: unknown[],
  ): UncheckedError {
    return new UncheckedError("BAD_REQUEST", message, issues);
  }

  static internal(message = "服务器内部错误"): UncheckedError {
    return new UncheckedError("INTERNAL_SERVER_ERROR", message);
  }

  static fromData(data: UncheckedErrorData): UncheckedError {
    return new UncheckedError(data.code, data.message, data.issues);
  }

  toData(): UncheckedErrorData {
    return {
      kind: this.kind,
      code: this.code,
      message: this.message,
      issues: this.issues,
    };
  }
}

/** A malformed request is an unchecked caller bug, analogous to a panic. */
export class MalformedRequestError extends UncheckedError {
  constructor(message: string, issues?: unknown[]) {
    super("BAD_REQUEST", message, issues);
    this.name = "MalformedRequestError";
  }
}

export function errorFromData(
  data: ActionErrorData,
): CheckedError | UncheckedError {
  return data.kind === "checked"
    ? CheckedError.fromData(data)
    : UncheckedError.fromData(data);
}
