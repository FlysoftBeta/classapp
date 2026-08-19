import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeAdmin(runtime: SmokeRuntime): Promise<void> {
  const users = await runtime.client.expectOk("adminFetchUsersAction", []);
  assert.ok(users.users.some((user) => user.id === runtime.userId));
  assert.ok(users.total >= 1);

  const config = await runtime.client.expectOk("adminFetchConfigAction", []);
  assert.equal(typeof config.system_locked, "boolean");
  assert.equal(typeof config.whitelist_enabled, "boolean");

  const clients = await runtime.client.expectOk("adminFetchClientsAction", []);
  assert.ok(Array.isArray(clients.clients));

  const groups = await runtime.client.expectOk("adminFetchGroupsAction", []);
  assert.ok(groups.groups.some((group) => group.id === "wild"));

  const audit = await runtime.client.expectOk("adminFetchAuditLogAction", []);
  assert.ok(Array.isArray(audit.entries));
}
