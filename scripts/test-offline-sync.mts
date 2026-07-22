import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chooseFurthestRead,
  chooseLatestTimestamped,
} from "../shared/sync/arbitration";
import {
  getConversationMutedState,
  getConversationPinnedState,
  setConversationMutedValue,
  setConversationPinnedValue,
} from "../server/data/conversations";
import {
  setArticleBookmarkValue,
  upsertArticleProgressOffset,
} from "../server/data/articles";
import { setRuntimeConfig } from "../server/infra/runtimeConfig";
import { initWordSchema } from "../server/data/words";

const pendingBoolean = { value: true, updatedAt: 20, pending: true };
const staleBoolean = { value: false, updatedAt: 10 };
assert.equal(
  chooseLatestTimestamped(pendingBoolean, staleBoolean),
  pendingBoolean,
  "an older response must not clear a newer Boolean pending value",
);

const canonicalTie = { value: false, updatedAt: 20 };
assert.equal(
  chooseLatestTimestamped(pendingBoolean, canonicalTie),
  canonicalTie,
  "the server canonical value must win an exact timestamp tie",
);

const currentRead = { postId: "p20", sequence: 20, updatedAt: 100 };
const laterPostWithOlderClock = {
  postId: "p21",
  sequence: 21,
  updatedAt: 1,
};
assert.equal(
  chooseFurthestRead(currentRead, laterPostWithOlderClock),
  laterPostWithOlderClock,
  "a further conversation post must win regardless of timestamp",
);

const earlierPostWithNewerClock = {
  postId: "p19",
  sequence: 19,
  updatedAt: 1_000,
};
assert.equal(
  chooseFurthestRead(currentRead, earlierPostWithNewerClock),
  currentRead,
  "conversation read position must never regress",
);

const newerProgress = { value: 50, updatedAt: 30, pending: true };
const olderProgressAck = { value: 10, updatedAt: 25 };
assert.equal(
  chooseLatestTimestamped(newerProgress, olderProgressAck),
  newerProgress,
  "an out-of-order article-progress acknowledgement must keep newer pending progress",
);

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE conversation_user_state (
    user_id TEXT NOT NULL,
    conversation_type TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    pinned_at TEXT,
    pinned_updated_at_ms INTEGER NOT NULL DEFAULT 0,
    muted INTEGER NOT NULL DEFAULT 0,
    muted_updated_at_ms INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, conversation_type, conversation_id)
  );
  CREATE TABLE article_read_progress (
    user_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    offset INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, article_id)
  );
  CREATE TABLE article_bookmarks (
    user_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    bookmarked INTEGER NOT NULL DEFAULT 1,
    updated_at_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, article_id)
  );
`);

const conversationKey = {
  userId: "u1",
  type: "group" as const,
  id: "g1",
};
setConversationMutedValue(db, {
  ...conversationKey,
  muted: true,
  updatedAt: 20,
});
setConversationMutedValue(db, {
  ...conversationKey,
  muted: false,
  updatedAt: 10,
});
assert.deepEqual(getConversationMutedState(db, conversationKey), {
  value: true,
  updatedAt: 20,
});

setConversationPinnedValue(db, {
  ...conversationKey,
  pinned: true,
  updatedAt: 20,
});
setConversationPinnedValue(db, {
  ...conversationKey,
  pinned: false,
  updatedAt: 10,
});
assert.deepEqual(getConversationPinnedState(db, conversationKey), {
  value: true,
  updatedAt: 20,
});

assert.deepEqual(upsertArticleProgressOffset(db, "u1", "a1", 50, 20), {
  offset: 50,
  updatedAt: 20,
});
assert.deepEqual(upsertArticleProgressOffset(db, "u1", "a1", 10, 10), {
  offset: 50,
  updatedAt: 20,
});
assert.deepEqual(setArticleBookmarkValue(db, "u1", "a1", true, 20), {
  value: true,
  updatedAt: 20,
});
assert.deepEqual(setArticleBookmarkValue(db, "u1", "a1", false, 10), {
  value: true,
  updatedAt: 20,
});
db.close();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "classapp-sync-v15-"));
const legacyPath = path.join(tempRoot, "data.db");
const prodPath = path.join(process.cwd(), "prod.db");
assert(fs.existsSync(prodPath), "prod.db migration baseline is missing");
fs.copyFileSync(prodPath, legacyPath);

const legacy = new Database(legacyPath);
assert.equal(
  (
    legacy
      .prepare("SELECT value FROM config WHERE key = 'schema_version'")
      .get() as { value: string }
  ).value,
  "14",
);
const legacyCounts = {
  bookmarks: (
    legacy.prepare("SELECT COUNT(*) AS count FROM article_bookmarks").get() as {
      count: number;
    }
  ).count,
  progress: (
    legacy
      .prepare("SELECT COUNT(*) AS count FROM article_read_progress")
      .get() as { count: number }
  ).count,
  clientIps: (
    legacy.prepare("SELECT COUNT(*) AS count FROM client_ips").get() as {
      count: number;
    }
  ).count,
  clients: (
    legacy.prepare("SELECT COUNT(*) AS count FROM clients").get() as {
      count: number;
    }
  ).count,
};
legacy.close();

setRuntimeConfig({
  appDir: process.cwd(),
  dataRoot: tempRoot,
  buildId: "sync-test",
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
const { getDb } = await import("../server/infra/db");
const migrated = getDb();
const columnNames = (table: string) =>
  new Set(
    (
      migrated.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[]
    ).map((column) => column.name),
  );
assert(columnNames("article_read_progress").has("updated_at_ms"));
assert(columnNames("article_bookmarks").has("bookmarked"));
assert(columnNames("article_bookmarks").has("updated_at_ms"));
assert(columnNames("conversation_user_state").has("pinned_updated_at_ms"));
assert(columnNames("clients").has("persistent"));
assert(columnNames("clients").has("remark"));
assert(columnNames("clients").has("whitelisted"));
assert(columnNames("clients").has("bound_user_id"));
assert.equal(
  (
    migrated
      .prepare("SELECT COUNT(*) AS count FROM article_bookmarks")
      .get() as {
      count: number;
    }
  ).count,
  legacyCounts.bookmarks,
);
assert.equal(
  (
    migrated
      .prepare("SELECT COUNT(*) AS count FROM article_read_progress")
      .get() as { count: number }
  ).count,
  legacyCounts.progress,
);
assert.equal(
  (
    migrated
      .prepare("SELECT COUNT(*) AS count FROM client_associations")
      .get() as { count: number }
  ).count,
  legacyCounts.clientIps,
);
assert.equal(
  (
    migrated
      .prepare("SELECT COUNT(*) AS count FROM clients WHERE persistent = 0")
      .get() as { count: number }
  ).count,
  legacyCounts.clients,
);
assert.equal(
  migrated
    .prepare("SELECT value FROM config WHERE key = 'whitelist_enabled'")
    .pluck()
    .get(),
  "0",
);
assert.equal(
  migrated
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('client_whitelist', 'client_pairing_codes')",
    )
    .pluck()
    .get(),
  0,
);
assert.equal(
  migrated
    .prepare("SELECT value FROM config WHERE key = 'client_identity_methods'")
    .pluck()
    .get(),
  "mac,user_agent",
);
assert.equal(
  (
    migrated
      .prepare(
        "SELECT COUNT(*) AS count FROM article_bookmarks WHERE bookmarked != 1",
      )
      .get() as { count: number }
  ).count,
  0,
);
assert.equal(
  (
    migrated
      .prepare("SELECT value FROM config WHERE key = 'schema_version'")
      .get() as { value: string }
  ).value,
  "15",
);
migrated.close();
fs.rmSync(tempRoot, { recursive: true, force: true });

console.log("offline synchronization arbitration tests passed");
