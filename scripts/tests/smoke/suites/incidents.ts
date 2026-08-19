import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeIncidents(runtime: SmokeRuntime): Promise<void> {
  const generated = await runtime.client.call("adminTestIncidentAction", []);
  assert.equal(generated.ok, false);
  if (!generated.ok) {
    assert.match(generated.error.incidentId, /^I_[A-Za-z0-9_-]{22}$/);
  }
  const groups = await runtime.client.expectOk(
    "adminFetchIncidentGroupsAction",
    [],
  );
  assert.ok(groups.groups.length >= 1);
}
