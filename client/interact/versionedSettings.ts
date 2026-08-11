import { observeActionResult } from "@/client/api/runtime";
const { fetchVersionedUserConfigAction, patchVersionedUserConfigAction } =
  client.actions;
import { client } from "@/client/interact/remote/client";
import { currentActorRepository as offlineRepository } from "@/client/interact/actorContext";
import type { OfflineRepository } from "@/client/data/repository";
import { captureDetachedClientIncident } from "@/client/interact/clientIncidents";

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
  const result = await fetchVersionedUserConfigAction({ keys: [key] });
  observeActionResult(result);
  if (!result.ok) return local?.value ?? fallback;
  const remote = result.data[key] ?? { value: null, updatedAt: 0 };
  if (local && local.updatedAt > remote.updatedAt) {
    await flushUserSetting(key, local.value, local.updatedAt);
    return local.value;
  }
  const value = remote.value ?? fallback;
  try {
    await offlineRepository.reconcileVersionedValue(USER_NAMESPACE, key, {
      value,
      updatedAt: remote.updatedAt,
    });
  } catch (error) {
    captureDetachedClientIncident("user-setting.read-cache", error);
  }
  return value;
}

async function flushUserSetting(key: string, value: string, updatedAt: number) {
  const result = await patchVersionedUserConfigAction({
    key,
    value,
    updatedAt,
  });
  observeActionResult(result);
  if (result.ok) {
    try {
      await offlineRepository.reconcileVersionedValue(USER_NAMESPACE, key, {
        value: result.data.value ?? value,
        updatedAt: result.data.updatedAt,
      });
    } catch (error) {
      captureDetachedClientIncident("user-setting.write-cache", error);
    }
  }
}

export async function writeUserSetting(key: string, value: string) {
  const local = await offlineRepository.setVersionedValue(
    USER_NAMESPACE,
    key,
    value,
  );
  if (client.isConnected()) {
    await flushUserSetting(key, value, local.updatedAt);
  }
  return local;
}

export async function reconcileUserSettingEvent(
  data: {
    key: string;
    value: string | null;
    updatedAt?: number;
  },
  repository: OfflineRepository = offlineRepository,
) {
  if (data.updatedAt === undefined || data.value === null) return data;
  const winner = await repository.reconcileVersionedValue(
    USER_NAMESPACE,
    data.key,
    { value: data.value, updatedAt: data.updatedAt },
  );
  return { ...data, value: winner.value, updatedAt: winner.updatedAt };
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
    } catch (error) {
      captureDetachedClientIncident("user-setting.flush", error);
      /* retry on reconnect */
    }
  }
}
