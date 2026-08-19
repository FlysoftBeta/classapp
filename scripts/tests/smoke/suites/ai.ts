import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeAi(runtime: SmokeRuntime): Promise<void> {
  const sidebar = await runtime.client.expectOk("fetchAiSidebarAction", []);
  assert.ok(Array.isArray(sidebar.conversations));
  assert.ok(sidebar.credits);
  assert.equal(typeof sidebar.status.available, "boolean");
  const billing = await runtime.client.expectOk("adminFetchAiBillingAction", []);
  assert.ok(billing.policy);
}
