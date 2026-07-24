import { observeActionResult } from "./runtime";
const { fetchVersionedUserConfigAction, patchVersionedUserConfigAction } =
  client.actions;
import { client } from "@/client/lib/remote/client";
import { offlineRepository } from "@/client/resource/offlineRepository";

const USER_NAMESPACE = "user-config";

export async function readUserSetting(
  key: string,
  fallback: string,
): Promise<string> {
  const local = await offlineRepository.getVersionedValue<string>(
    USER_NAMESPACE,
    key,
  );
  if (!client.isConnected()) return local?.value ?? fallback;
  try {
    const result = await fetchVersionedUserConfigAction({ keys: [key] });
    observeActionResult(result);
    if (!result.ok) return local?.value ?? fallback;
    const remote = result.data[key] ?? { value: null, updatedAt: 0 };
    if (local && local.updatedAt > remote.updatedAt) {
      await flushUserSetting(key, local.value, local.updatedAt);
      return local.value;
    }
    const value = remote.value ?? fallback;
    await offlineRepository.reconcileVersionedValue(USER_NAMESPACE, key, {
      value,
      updatedAt: remote.updatedAt,
    });
    return value;
  } catch {
    return local?.value ?? fallback;
  }
}

async function flushUserSetting(key: string, value: string, updatedAt: number) {
  const result = await patchVersionedUserConfigAction({
    key,
    value,
    updatedAt,
  });
  observeActionResult(result);
  if (result.ok)
    await offlineRepository.reconcileVersionedValue(USER_NAMESPACE, key, {
      value: result.data.value ?? value,
      updatedAt: result.data.updatedAt,
    });
}

export async function writeUserSetting(key: string, value: string) {
  const local = await offlineRepository.setVersionedValue(
    USER_NAMESPACE,
    key,
    value,
  );
  if (client.isConnected()) {
    try {
      await flushUserSetting(key, value, local.updatedAt);
    } catch {
      /* remains pending */
    }
  }
  return local;
}

export async function syncPendingUserSettings() {
  if (!client.isConnected()) return;
  for (const {
    id,
    version,
  } of await offlineRepository.getPendingVersionedValues<string>(
    USER_NAMESPACE,
  )) {
    try {
      await flushUserSetting(id, version.value, version.updatedAt);
    } catch {
      /* retry on reconnect */
    }
  }
}
