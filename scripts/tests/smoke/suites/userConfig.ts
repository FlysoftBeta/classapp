import assert from "node:assert/strict";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import type { SmokeRuntime } from "../harness";

export async function smokeUserConfig(runtime: SmokeRuntime): Promise<void> {
  const dnd = await runtime.client.expectOk("fetchNotificationConfigAction", []);
  assert.equal(typeof dnd.doNotDisturb, "boolean");
  const updated = await runtime.client.expectOk("updateDoNotDisturbAction", [
    { enabled: true },
  ]);
  assert.equal(updated.doNotDisturb, true);

  const config = await runtime.client.expectOk(
    "fetchVersionedUserConfigAction",
    [{ keys: [USER_CONFIG.THEME_MODE] }],
  );
  assert.ok(USER_CONFIG.THEME_MODE in config);
  const patched = await runtime.client.expectOk(
    "patchVersionedUserConfigAction",
    [{ key: USER_CONFIG.THEME_MODE, value: "dark", updatedAt: Date.now() }],
  );
  assert.equal(patched.value, "dark");
}
