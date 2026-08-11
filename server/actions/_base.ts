import { ContractViolationError } from "@/server/services/incidentService";
import { Session } from "@/server/session/session";

export async function withActionSession<T>(
  handler: (session: Session) => Promise<T>,
): Promise<T> {
  const session = await Session.fromActionContext();
  return handler(session);
}

export function expectString(
  value: unknown,
  message: string,
  options?: { trim?: boolean },
): string {
  if (typeof value !== "string") {
    throw new ContractViolationError(message);
  }
  return options?.trim === false ? value : value.trim();
}

export function expectBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") {
    throw new ContractViolationError(message);
  }
  return value;
}
