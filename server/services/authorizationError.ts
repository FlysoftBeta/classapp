import { PublicError } from "@/server/services/incidentService";

export type AuthorizationFailureCode =
  | "denied"
  | "invalid_capability"
  | "expired_capability"
  | "not_found";

const MESSAGES: Record<AuthorizationFailureCode, string> = {
  denied: "无权访问",
  invalid_capability: "访问证明无效",
  expired_capability: "访问证明已过期",
  not_found: "资源不存在",
};

/** Domain authorization outcome. Facades map this to a public Action failure. */
export class AuthorizationError extends PublicError {
  constructor(
    readonly code: AuthorizationFailureCode,
    publicMessage = MESSAGES[code],
  ) {
    super(publicMessage, publicMessage);
    this.name = "AuthorizationError";
  }
}
