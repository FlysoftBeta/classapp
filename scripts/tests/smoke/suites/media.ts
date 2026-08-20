import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeMedia(runtime: SmokeRuntime): Promise<void> {
  const queue = await runtime.client.expectOk("mediaFetchQueueAction", []);
  assert.ok(queue.list);
  assert.ok(Array.isArray(queue.items));
  assert.ok(Array.isArray(queue.tracks));
  const library = await runtime.client.expectOk("mediaLibraryAction", []);
  assert.ok(Array.isArray(library.recents));
  assert.ok(Array.isArray(library.favorites));
  assert.ok(Array.isArray(library.playlists));
  const playlists = await runtime.client.expectOk("mediaListPlaylistsAction", []);
  assert.ok(Array.isArray(playlists.playlists));
  const created = await runtime.client.expectOk("mediaCreatePlaylistAction", [
    { title: "测试歌单" },
  ]);
  assert.equal(created.list.title, "测试歌单");
  assert.equal(created.list.access.own, true);
  assert.ok(Array.isArray(created.tracks));
  const afterCreate = await runtime.client.expectOk("mediaListPlaylistsAction", []);
  assert.ok(afterCreate.playlists.some((entry) => entry.id === created.list.id));
  const config = await runtime.client.expectOk("mediaFetchConfigAction", []);
  assert.equal(typeof config.enabled, "boolean");
  assert.equal(typeof config.max_volume, "number");
}
