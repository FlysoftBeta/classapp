import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { setRuntimeConfig } from "@/server/infra/runtimeConfig";

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "classapp-schema-migration-"),
);
const source = path.join(process.cwd(), "prod.db");
const target = path.join(root, "data.db");
fs.copyFileSync(source, target);

const fixture = new BetterSqlite3(target);
const originalVersion = fixture
  .prepare("SELECT value FROM config WHERE key = 'schema_version'")
  .get() as { value: string };
assert.equal(
  originalVersion.value,
  "14",
  "prod.db must remain the v14 baseline",
);

const originalGroupColumn = (
  fixture.pragma("table_info(articles)") as { name: string; notnull: number }[]
).find((column) => column.name === "group_id");
assert.equal(originalGroupColumn?.notnull, 1);

const sample = fixture
  .prepare(
    "SELECT id, group_id, content, content_kind FROM articles ORDER BY id LIMIT 1",
  )
  .get() as
  | { id: string; group_id: string; content: string; content_kind: string }
  | undefined;
const adminId = (
  fixture
    .prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
    .get() as {
    id: string;
  }
).id;
fixture
  .prepare(
    `INSERT OR REPLACE INTO posts
       (id, user_id, content, brief, group_id, dm_to)
     VALUES ('migration-test-ghost-dm', NULL, 'ghost', 'ghost', NULL, ?)`,
  )
  .run(adminId);
fixture
  .prepare(
    `INSERT OR REPLACE INTO posts
       (id, user_id, content, brief, group_id, dm_to, is_deleted, deleted_at)
     VALUES ('migration-test-tombstone', ?, 'secret', 'secret', 'wild', NULL, 1, datetime('now'))`,
  )
  .run(adminId);
fixture
  .prepare(
    `INSERT OR REPLACE INTO conversation_user_state
       (user_id, conversation_type, conversation_id)
     VALUES (?, 'dm', 'migration-test-missing-user')`,
  )
  .run(adminId);
fixture.close();

setRuntimeConfig({
  appDir: process.cwd(),
  dataRoot: root,
  buildId: "schema-migration-test",
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

const { getDb } = await import("@/server/infra/db");
const db = getDb();

try {
  assert.equal(
    (
      db
        .prepare("SELECT value FROM config WHERE key = 'schema_version'")
        .get() as {
        value: string;
      }
    ).value,
    "16",
  );
  assert.deepEqual(
    db
      .prepare(
        `SELECT brief, content_json, (deleted_at IS NOT NULL) AS deleted
         FROM posts WHERE id = 'migration-test-tombstone'`,
      )
      .get(),
    { brief: "", content_json: '{"type":"deleted"}', deleted: 1 },
  );
  const groupColumn = (
    db.pragma("table_info(articles)") as { name: string; notnull: number }[]
  ).find((column) => column.name === "group_id");
  assert.equal(groupColumn?.notnull, 1);
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM articles WHERE group_id IS NULL")
        .get() as { n: number }
    ).n,
    0,
  );
  assert.equal(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT conv_id FROM posts GROUP BY conv_id
             HAVING COUNT(*) != COUNT(DISTINCT revision)
           )`,
        )
        .get() as { n: number }
    ).n,
    0,
    "Migrated post revisions must be unique within each conversation",
  );
  assert.equal(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT c.conv_id
             FROM (
               SELECT conv_id, revision FROM groups
               UNION ALL SELECT conv_id, revision FROM dms
             ) c
             LEFT JOIN posts p ON p.conv_id = c.conv_id
             GROUP BY c.conv_id, c.revision
             HAVING c.revision != COALESCE(MAX(p.revision), 0)
           )`,
        )
        .get() as { n: number }
    ).n,
    0,
    "Conversation awareness revision must equal its latest current post row",
  );
  if (sample) {
    assert.deepEqual(
      db
        .prepare("SELECT id, group_id FROM articles WHERE id = ?")
        .get(sample.id),
      { id: sample.id, group_id: sample.group_id },
    );
    const migrated = db
      .prepare("SELECT provider_json FROM articles WHERE id = ?")
      .get(sample.id) as { provider_json: string };
    assert.equal(JSON.parse(migrated.provider_json).type, sample.content_kind);
    if (sample.content_kind === "text") {
      const content = (
        db
          .prepare(
            "SELECT content FROM text_article_segments WHERE article_id = ? ORDER BY segment_index",
          )
          .all(sample.id) as Array<{ content: string }>
      )
        .map((row) => row.content)
        .join("");
      assert.equal(content, sample.content);
    }
  }
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM posts WHERE id = 'migration-test-ghost-dm'",
        )
        .get() as { n: number }
    ).n,
    0,
  );
  assert.equal(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM convs_user
           WHERE conv_id LIKE '%migration-test-missing-user%'`,
        )
        .get() as { n: number }
    ).n,
    0,
  );
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_check")
        .get() as { n: number }
    ).n,
    0,
  );
  for (const obsolete of ["user_groups", "conversation_user_state"]) {
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(obsolete) as { n: number }
      ).n,
      0,
    );
  }
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("schema migration tests passed");
