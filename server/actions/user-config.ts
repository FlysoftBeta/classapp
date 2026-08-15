import { withActionScope, expectString } from "./_base";
import { ContractViolationError } from "@/server/services/incidentService";
import { OFFLINE_WRITABLE_USER_CONFIG } from "@/shared/userConfig/keys";
import type { ActionInput } from "@/shared/protocol/actions";

const allowed = new Set<string>(OFFLINE_WRITABLE_USER_CONFIG);

function keyOf(value: unknown): string {
  const key = expectString(value, "配置键无效");
  if (!allowed.has(key)) throw new ContractViolationError("配置键不可离线修改");
  return key;
}

export async function fetchVersionedUserConfigAction(
  input: ActionInput<"fetchVersionedUserConfigAction">,
) {
  return withActionScope(async (scope) => {
    if (!Array.isArray(input.keys))
      throw new ContractViolationError("配置键无效");
    return scope.facades().versionedUserConfig().get(input.keys.map(keyOf));
  });
}

export async function patchVersionedUserConfigAction(
  input: ActionInput<"patchVersionedUserConfigAction">,
) {
  return withActionScope(async (scope) => {
    const key = keyOf(input.key);
    const value = expectString(input.value, "配置值无效", { trim: false });
    if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0)
      throw new ContractViolationError("配置时间戳无效");
    return scope
      .facades()
      .versionedUserConfig()
      .set(key, value, input.updatedAt);
  });
}
