import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeMedia(runtime: SmokeRuntime): Promise<void> {
  const queue = await runtime.client.expectOk("mediaFetchQueueAction", []);
  assert.ok(queue.list);
  assert.ok(Array.isArray(queue.items));
  const playlists = await runtime.client.expectOk("mediaListPlaylistsAction", []);
  assert.ok(Array.isArray(playlists.playlists));
  const config = await runtime.client.expectOk("mediaFetchConfigAction", []);
  assert.equal(typeof config.enabled, "boolean");
  assert.equal(typeof config.max_volume, "number");
}
