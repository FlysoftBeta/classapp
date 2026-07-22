import { BUILD_ID } from "@/server/infra/env";
import { ServiceError } from "@/server/services/errors";
import {
  CheckedError,
  MalformedRequestError,
  UncheckedError,
  type ActionErrorData,
  type CheckedErrorCode,
} from "@/shared/protocol/errors";
import { ResultTools, type ActionResult } from "@/shared/protocol/result";

const checkedCodeByStatus: Partial<Record<number, CheckedErrorCode>> = {
  401: "AUTHENTICATION_FAILED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "THROTTLED",
};

function packError(error: unknown): ActionErrorData {
  if (error instanceof CheckedError) return error.toData();
  if (error instanceof MalformedRequestError) return error.toData();
  if (error instanceof UncheckedError) {
    return error.code === "INTERNAL_SERVER_ERROR"
      ? UncheckedError.internal().toData()
      : error.toData();
  }
  if (error instanceof ServiceError) {
    const checkedCode = checkedCodeByStatus[error.status];
    if (checkedCode) {
      return new CheckedError(
        checkedCode,
        error.message,
        error.status,
        false,
      ).toData();
    }
    if (error.status >= 500) {
      console.error("[ActionDispatcher] ServiceError", error);
      return UncheckedError.internal().toData();
    }
    return UncheckedError.badRequest(error.message).toData();
  }
  console.error("[ActionDispatcher] Unhandled error", error);
  return UncheckedError.internal().toData();
}

export class ServerResultCodec {
  static async capture<T>(
    operation: () => Promise<T>,
  ): Promise<ActionResult<T>> {
    const meta = { buildId: BUILD_ID };
    try {
      return ResultTools.ok(await operation(), meta);
    } catch (error) {
      return ResultTools.err(packError(error), meta);
    }
  }
}
