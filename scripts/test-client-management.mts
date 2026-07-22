import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setRuntimeConfig } from "../server/infra/runtimeConfig";

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "classapp-clients-v15-"),
);
setRuntimeConfig({
  appDir: process.cwd(),
  dataRoot: tempRoot,
  buildId: "client-test",
  ports: [0],
  bindHost: "127.0.0.1",
  nodeEnv: "test",
  initialAdminPin: "123456",
  update: {
    enabled: false,
    stagingDir: path.join(tempRoot, "staging"),
    backupDir: path.join(tempRoot, "backup"),
  },
});

const [{ getDb }, { createClientService }, { cleanupInactiveClients }] =
  await Promise.all([
    import("../server/infra/db"),
    import("../server/services/clientsService"),
    import("../server/services/maintenance"),
  ]);

const db = getDb();
const clients = createClientService(db);
assert.deepEqual(clients.config(), {
  whitelist_enabled: false,
  identity_methods: ["mac", "user_agent"],
});

const firstIdentity = {
  mac: "aa:bb:cc:dd:ee:ff",
  ip: "10.0.0.2",
  userAgent: "ClassApp Test/1",
};
const firstId = clients.getOrCreateForIdentity(firstIdentity);
assert.match(firstId, /^C-[0-9A-F]{8}$/);
assert.equal(
  clients.getOrCreateForIdentity({ ...firstIdentity, ip: "10.0.0.3" }),
  firstId,
  "IP is not part of the default MAC + UA tuple",
);

const temporaryId = clients.getOrCreateForIdentity({
  ...firstIdentity,
  userAgent: "ClassApp Test/2",
});
assert.notEqual(temporaryId, firstId);
assert.equal(
  clients.list().clients.find((client) => client.id === firstId)?.persistent,
  false,
);

const admin = db
  .prepare("SELECT id, handle FROM users WHERE role = 'admin' LIMIT 1")
  .get() as { id: string; handle: string };
clients.promote(firstId);
clients.updateProps(firstId, {
  remark: "测试终端",
  whitelisted: true,
  bound_user_id: admin.id,
});
clients.updateConfig({ whitelist_enabled: true });
assert.equal(clients.isIdentityAllowed(firstIdentity, firstId), true);
assert.equal(
  clients.isIdentityAllowed(
    { ...firstIdentity, userAgent: "ClassApp Test/2" },
    temporaryId,
  ),
  false,
);
assert.equal(clients.canLoginUser(firstId, admin.id), true);
assert.equal(clients.canLoginUser(firstId, "someone-else"), false);

const persistent = clients.list(0, 50, "测试终端").clients[0];
assert.equal(persistent.id, firstId);
assert.equal(persistent.persistent, true);
assert.equal(persistent.whitelisted, true);
assert.equal(persistent.bound_user_handle, admin.handle);

db.prepare(
  "UPDATE client_associations SET last_seen = datetime('now', '-2 days')",
).run();
db.prepare(
  "UPDATE client_ips SET last_seen = datetime('now', '-2 days')",
).run();
db.prepare("UPDATE clients SET created_at = datetime('now', '-2 days')").run();
const deleted = cleanupInactiveClients(db);
assert.deepEqual(deleted, [temporaryId]);
assert(db.prepare("SELECT 1 FROM clients WHERE id = ?").get(firstId));

db.close();
fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("client lifecycle tests passed");
