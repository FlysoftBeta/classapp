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
  .prepare("SELECT id, group_id FROM articles ORDER BY id LIMIT 1")
  .get() as { id: string; group_id: string } | undefined;
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
    "15",
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
  if (sample) {
    assert.deepEqual(
      db
        .prepare("SELECT id, group_id FROM articles WHERE id = ?")
        .get(sample.id),
      sample,
    );
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
          `SELECT COUNT(*) AS n FROM conversation_user_state
           WHERE conversation_type = 'dm'
             AND conversation_id = 'migration-test-missing-user'`,
        )
        .get() as { n: number }
    ).n,
    0,
  );
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("schema migration tests passed");
