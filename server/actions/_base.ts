import { ContractViolationError } from "@/server/services/incidentService";
import { currentScope, type Scope } from "@/server/runtime/scope";

export async function withActionScope<T>(
  handler: (scope: Scope) => Promise<T>,
): Promise<T> {
  return handler(currentScope());
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
