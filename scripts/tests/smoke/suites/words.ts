import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeWords(runtime: SmokeRuntime): Promise<void> {
  const stats = await runtime.client.expectOk("fetchWordStatsAction", []);
  assert.equal(typeof stats.stats.total, "number");
  const next = await runtime.client.expectOk("fetchNextWordAction", []);
  assert.ok(next.word === null || typeof next.word.id === "string");
  const mode = await runtime.client.expectOk("fetchSelfDisciplineModeAction", []);
  assert.equal(typeof mode.enabled, "boolean");
}
