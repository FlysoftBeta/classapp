import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeApp(runtime: SmokeRuntime): Promise<void> {
  const locked = await runtime.client.expectOk("patchClientMeAction", [true]);
  assert.equal(locked.ok, true);
  if (locked.ok && "konami_locked" in locked) {
    assert.equal(locked.konami_locked, true);
  }
  const unlocked = await runtime.client.expectOk("patchClientMeAction", [false]);
  assert.equal(unlocked.ok, true);
  if (unlocked.ok && "konami_locked" in unlocked) {
    assert.equal(unlocked.konami_locked, false);
  }
}
