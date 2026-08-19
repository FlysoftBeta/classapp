import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeStickers(runtime: SmokeRuntime): Promise<void> {
  const packs = await runtime.client.expectOk("fetchStickerPacksAction", []);
  assert.ok(Array.isArray(packs.packs));
  const recent = await runtime.client.expectOk("fetchRecentStickersAction", []);
  assert.ok(Array.isArray(recent.recent));
  if (packs.packs[0]) {
    const pack = await runtime.client.expectOk("fetchStickerPackAction", [
      packs.packs[0].id,
    ]);
    assert.equal(pack.pack.id, packs.packs[0].id);
  }
}
