import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeGroups(runtime: SmokeRuntime): Promise<void> {
  const handle = `smoke_${Date.now().toString(36)}`;
  const created = await runtime.client.expectOk("createGroupAction", [
    { name: "Smoke 群组", handle, discoverable: false },
  ]);
  assert.equal(created.group.handle, handle);
  assert.equal(created.group.name, "Smoke 群组");
  assert.equal(created.group.conv_id, `group:${created.group.id}`);

  const members = await runtime.client.expectOk("fetchGroupMembersAction", [
    created.group.id,
  ]);
  assert.ok(members.members.some((member) => member.id === runtime.userId));

  const discovery = await runtime.client.expectOk("discoverGroupsAction", []);
  assert.ok(Array.isArray(discovery.sections));
}
