import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setRuntimeConfig } from "@/server/infra/runtimeConfig";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "classapp-user-lifecycle-"));
setRuntimeConfig({
  appDir: process.cwd(),
  dataRoot: root,
  buildId: "user-lifecycle-test",
  ports: [3000],
  securePorts: [],
  bindHost: "127.0.0.1",
  trustedProxyIps: [],
  nodeEnv: "development",
  initialAdminPin: "123456",
  https: {
    domain: null,
    certificatePath: null,
    privateKeyPath: null,
    rootCertificatePath: null,
  },
  update: {
    enabled: false,
    stagingDir: path.join(root, "staging"),
    backupDir: path.join(root, "backup"),
  },
});

const [
  { getDb },
  { createUserService },
  { createClientService },
  { canClientLogin },
  posts,
  conversations,
] = await Promise.all([
  import("@/server/infra/db"),
  import("@/server/services/usersService"),
  import("@/server/services/clientsService"),
  import("@/server/data/clients"),
  import("@/server/data/posts"),
  import("@/server/data/conversations"),
]);
const db = getDb();

try {
  const adminId = (
    db.prepare("SELECT id FROM users WHERE role = 'admin'").get() as {
      id: string;
    }
  ).id;
  const users = createUserService(db);
  const peer = users.create({
    handle: "peer",
    username: "Peer",
    pin: "654320",
  });
  const deactivated = users.create({
    handle: "retired",
    username: "Retired Name",
    pin: "654321",
  });
  posts.insertPost(db, {
    id: "dm-deactivated",
    userId: deactivated.id,
    brief: "hello",
    contentJson: JSON.stringify({ type: "text", text_same_as_brief: true }),
    groupId: null,
    dmTo: peer.id,
    replyTo: null,
  });
  db.prepare(
    "INSERT INTO user_config(user_id, key, value) VALUES (?, 'kept', 'yes')",
  ).run(deactivated.id);
  db.prepare(
    `INSERT INTO clients(id, persistent, bound_user_id)
     VALUES ('retained-client', 1, ?)`,
  ).run(deactivated.id);

  await users.remove(deactivated.id, adminId, "deactivate");

  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) n FROM deleted_users WHERE id = ?")
        .get(deactivated.id) as { n: number }
    ).n,
    1,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT bound_user_id FROM clients WHERE id = 'retained-client'",
        )
        .get() as {
        bound_user_id: string | null;
      }
    ).bound_user_id,
    deactivated.id,
  );
  assert.equal(createClientService(db).isBound("retained-client"), false);
  assert.equal(canClientLogin(db, "retained-client", peer.id), true);
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) n FROM users WHERE id = ?")
        .get(deactivated.id) as { n: number }
    ).n,
    1,
  );
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) n FROM user_groups WHERE user_id = ?")
        .get(deactivated.id) as { n: number }
    ).n,
    0,
  );
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) n FROM user_config WHERE user_id = ?")
        .get(deactivated.id) as { n: number }
    ).n,
    1,
  );
  const retainedDm = conversations
    .listConversations(db, peer.id)
    .find((entry) => entry.type === "dm" && entry.id === deactivated.id);
  assert.equal(retainedDm?.name, "Retired Name");

  const purged = users.create({
    handle: "purged",
    username: "Purged",
    pin: "654322",
  });
  posts.insertPost(db, {
    id: "dm-purged",
    userId: purged.id,
    brief: "bye",
    contentJson: JSON.stringify({ type: "text", text_same_as_brief: true }),
    groupId: null,
    dmTo: peer.id,
    replyTo: null,
  });
  db.prepare(
    "INSERT INTO user_config(user_id, key, value) VALUES (?, 'gone', 'yes')",
  ).run(purged.id);
  db.prepare(
    "INSERT INTO articles(id, user_id, title, content) VALUES ('purged-article', ?, 't', 'c')",
  ).run(purged.id);
  db.prepare(
    `INSERT INTO conversation_user_state(user_id, conversation_type, conversation_id)
     VALUES (?, 'dm', ?)`,
  ).run(purged.id, peer.id);
  const wordId = (
    db.prepare("SELECT id FROM words LIMIT 1").get() as { id: string }
  ).id;
  db.prepare(
    `INSERT INTO user_word_progress(user_id, word_id)
     VALUES (?, ?)`,
  ).run(purged.id, wordId);
  db.prepare(
    `INSERT INTO clients(id, persistent, bound_user_id)
     VALUES ('purged-client', 1, ?)`,
  ).run(purged.id);

  await users.remove(purged.id, adminId, "purge");

  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) n FROM users WHERE id = ?")
        .get(purged.id) as {
        n: number;
      }
    ).n,
    0,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) n FROM conversation_user_state WHERE user_id = ?",
        )
        .get(purged.id) as { n: number }
    ).n,
    0,
  );
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) n FROM user_word_progress WHERE user_id = ?")
        .get(purged.id) as { n: number }
    ).n,
    0,
  );
  assert.equal(
    (
      db
        .prepare("SELECT bound_user_id FROM clients WHERE id = 'purged-client'")
        .get() as { bound_user_id: string | null }
    ).bound_user_id,
    null,
  );
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) n FROM posts WHERE user_id = ? OR dm_to = ?")
        .get(purged.id, purged.id) as { n: number }
    ).n,
    0,
  );
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) n FROM user_config WHERE user_id = ?")
        .get(purged.id) as { n: number }
    ).n,
    0,
  );
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) n FROM articles WHERE user_id = ?")
        .get(purged.id) as { n: number }
    ).n,
    0,
  );
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("user lifecycle tests passed");
