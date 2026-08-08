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
  articles,
  postService,
] = await Promise.all([
  import("@/server/infra/db"),
  import("@/server/services/usersService"),
  import("@/server/services/clientsService"),
  import("@/server/data/clients"),
  import("@/server/data/posts"),
  import("@/server/data/conversations"),
  import("@/server/data/articles"),
  import("@/server/services/postsService"),
]);
const db = getDb();

try {
  const adminId = (
    db.prepare("SELECT id FROM users WHERE role = 'admin'").get() as {
      id: string;
    }
  ).id;
  const text = `${"甲".repeat(9_999)}😀乙`;
  articles.insertTextArticle(db, {
    id: "segmented-article",
    userId: adminId,
    groupId: "wild",
    title: "segmented",
    content: text,
  });
  assert.deepEqual(
    JSON.parse(
      (
        db
          .prepare(
            "SELECT provider_json FROM articles WHERE id = 'segmented-article'",
          )
          .get() as { provider_json: string }
      ).provider_json,
    ),
    { type: "text", words: text.length, chunks: 2 },
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT content FROM text_article_segments WHERE article_id = 'segmented-article' ORDER BY segment_index",
        )
        .all() as Array<{ content: string }>
    )
      .map((row) => row.content)
      .join(""),
    text,
  );
  assert.throws(() =>
    db
      .prepare(
        "UPDATE articles SET title = 'changed' WHERE id = 'segmented-article'",
      )
      .run(),
  );
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO articles(id, user_id, group_id, title, provider_json)
         VALUES ('invalid-provider', ?, 'wild', 'bad', '{"type":"text","words":1}')`,
      )
      .run(adminId),
  );
  for (const id of ["catchup-1", "catchup-2", "catchup-3"]) {
    posts.insertPost(db, {
      id,
      userId: adminId,
      convId: "group:wild",
      brief: id,
      contentJson: '{"type":"text","text_same_as_brief":true}',
      replyTo: null,
    });
  }
  const firstRevisionPage = postService.getGroupPosts(
    db,
    adminId,
    "wild",
    { changed_after_revision: 0, changed_through_revision: 3, limit: 2 },
    true,
  );
  assert.deepEqual(
    firstRevisionPage.map((post) => post.revision),
    [1, 2],
  );
  posts.updatePostBody(
    db,
    "catchup-3",
    "changed",
    '{"type":"text","text_same_as_brief":true}',
  );
  assert.deepEqual(
    postService
      .getGroupPosts(
        db,
        adminId,
        "wild",
        {
          changed_after_revision: 2,
          changed_through_revision: 3,
          limit: 2,
        },
        true,
      )
      .map((post) => post.id),
    [],
    "A row changed beyond the snapshot bound is deferred, not offset-shifted",
  );
  assert.deepEqual(
    postService
      .getGroupPosts(
        db,
        adminId,
        "wild",
        {
          changed_after_revision: 3,
          changed_through_revision: 4,
          limit: 2,
        },
        true,
      )
      .map((post) => [post.id, post.revision]),
    [["catchup-3", 4]],
  );
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO posts(id, author_id, conv_id, brief, content_json)
         VALUES ('invalid-conversation', ?, 'group:missing', '',
           '{"type":"text","text_same_as_brief":true}')`,
      )
      .run(adminId),
  );
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO posts(id, author_id, conv_id, brief, content_json, deleted_at)
         VALUES ('invalid-tombstone', ?, 'group:wild', '',
           '{"type":"deleted","reason":"must-not-persist"}', datetime('now'))`,
      )
      .run(adminId),
  );
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
  const deactivatedConvId = conversations.insertDmConversation(
    db,
    deactivated.id,
    peer.id,
    "wild",
  );
  posts.insertPost(db, {
    id: "dm-deactivated",
    userId: deactivated.id,
    brief: "hello",
    contentJson: JSON.stringify({ type: "text", text_same_as_brief: true }),
    convId: deactivatedConvId,
    replyTo: null,
  });
  assert.deepEqual(
    db
      .prepare("SELECT revision FROM dms WHERE conv_id = ?")
      .get(deactivatedConvId),
    { revision: 1 },
  );
  assert.deepEqual(
    db.prepare("SELECT revision FROM posts WHERE id = 'dm-deactivated'").get(),
    { revision: 1 },
  );
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
        .prepare("SELECT COUNT(*) n FROM group_members WHERE user_id = ?")
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
  const purgedConvId = conversations.insertDmConversation(
    db,
    purged.id,
    peer.id,
    "wild",
  );
  posts.insertPost(db, {
    id: "dm-purged",
    userId: purged.id,
    brief: "bye",
    contentJson: JSON.stringify({ type: "text", text_same_as_brief: true }),
    convId: purgedConvId,
    replyTo: null,
  });
  db.prepare(
    "INSERT INTO user_config(user_id, key, value) VALUES (?, 'gone', 'yes')",
  ).run(purged.id);
  db.prepare(
    `INSERT INTO articles(id, user_id, group_id, title, provider_json)
     VALUES ('purged-article', ?, 'wild', 't', '{"type":"text","words":1,"chunks":1}')`,
  ).run(purged.id);
  db.prepare(`INSERT INTO convs_user(user_id, conv_id) VALUES (?, ?)`).run(
    purged.id,
    purgedConvId,
  );
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
        .prepare("SELECT COUNT(*) n FROM convs_user WHERE user_id = ?")
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
        .prepare(
          `SELECT COUNT(*) n FROM posts
           WHERE id = 'dm-purged'
             AND json_extract(content_json, '$.type') = 'deleted'`,
        )
        .get() as { n: number }
    ).n,
    1,
  );
  assert.deepEqual(
    db.prepare("SELECT revision FROM posts WHERE id = 'dm-purged'").get(),
    { revision: 2 },
  );
  assert.deepEqual(
    postService
      .getDmPosts(db, peer.id, purged.id, {
        changed_after_revision: 1,
        changed_through_revision: 2,
        limit: 10,
      })
      .map((post) => ({
        id: post.id,
        type: post.type,
        revision: post.revision,
      })),
    [{ id: "dm-purged", type: "deleted", revision: 2 }],
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
