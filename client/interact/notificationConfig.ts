import { USER_CONFIG } from "@/shared/userConfig/keys";
import { ResultTools } from "@/shared/protocol/result";
import { client } from "./remote/client";
import { readUserSetting, writeUserSetting } from "./versionedSettings";

export async function fetchNotificationConfig() {
  return {
    doNotDisturb:
      (await readUserSetting(USER_CONFIG.DO_NOT_DISTURB, "false")) === "true",
  };
}

export async function updateDoNotDisturb(enabled: boolean) {
  const local = await writeUserSetting(
    USER_CONFIG.DO_NOT_DISTURB,
    String(enabled),
  );
  return ResultTools.ok(
    { doNotDisturb: local.value === "true" },
    { buildId: client.buildId },
  );
}
