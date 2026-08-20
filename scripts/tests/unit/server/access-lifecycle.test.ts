import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { AccessService } from "@/server/services/accessService";
import { OwnerlessCapabilityService } from "@/server/services/ownerlessCapability";
import { CapabilityService } from "@/server/services/capabilityService";
import { listBindingsForPrincipal } from "@/server/data/access";
import { reclaimExpiredQueues } from "@/server/services/mediaPlaylistService";
import { listArticlesForUser } from "@/server/data/articles";
import { actionContracts } from "@/shared/protocol/actions";
import {
  SEARCH_CAPABILITY_TTL_MS,
  collectionSource,
} from "@/shared/access";

function memoryAccessDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE groups (id TEXT PRIMARY KEY);
    CREATE TABLE group_members (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE access_bindings (
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      principal_kind TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      grants_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (resource_kind, resource_id, principal_kind, principal_id)
    );
    CREATE TABLE access_effective (
      user_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      can_read INTEGER NOT NULL,
      can_write INTEGER NOT NULL,
      can_own INTEGER NOT NULL,
      can_share_read INTEGER NOT NULL,
      can_share_write INTEGER NOT NULL,
      can_share_own INTEGER NOT NULL,
      provenance_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, resource_kind, resource_id)
    );
    CREATE TABLE resource_possession (
      user_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      expires_at_ms INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, resource_kind, resource_id)
    );
  `);
  return db;
}

test("remembering a search token does not shrink a longer collection possession", () => {
  const db = memoryAccessDb();
  db.exec(`INSERT INTO users (id) VALUES ('alice')`);
  const ownerless = new OwnerlessCapabilityService(
    db,
    new CapabilityService("test-secret"),
    new AccessService(db),
  );
  const issuedAt = 1_000;
  const collection = ownerless.issue(
    "track",
    "t1",
    collectionSource("playlist", "p1"),
    issuedAt,
  );
  ownerless.remember("alice", "track", "t1", collection, issuedAt);
  const search = ownerless.issue("track", "t1", { type: "search" }, issuedAt);
  ownerless.remember("alice", "track", "t1", search, issuedAt);
  const afterSearchExpiry = issuedAt + SEARCH_CAPABILITY_TTL_MS + 1;
  const held = ownerless.require(
    "alice",
    "track",
    "t1",
    undefined,
    afterSearchExpiry,
  );
  assert.equal(held.recovered, false);
  assert.match(held.capability, /^c1\./);
});

test("last-member group deletion drops group bindings, not only the member's effective row", () => {
  const db = memoryAccessDb();
  db.exec(`
    INSERT INTO users (id) VALUES ('bob');
    INSERT INTO groups (id) VALUES ('g1');
    INSERT INTO group_members (group_id, user_id) VALUES ('g1', 'bob');
  `);
  const access = new AccessService(db);
  access.bindOwner("booklist", "bl1", { kind: "group", id: "g1" });
  assert.equal(access.peek("bob", "booklist", "bl1").own, true);
  db.prepare("DELETE FROM group_members WHERE user_id = ?").run("bob");
  db.prepare("DELETE FROM groups WHERE id = ?").run("g1");
  access.onGroupMembershipChanged("bob", "g1", true);
  assert.equal(access.peek("bob", "booklist", "bl1").read, false);
  assert.deepEqual(
    listBindingsForPrincipal(db, { kind: "group", id: "g1" }),
    [],
  );
});

test("reclaimExpiredQueues drops queue access bindings with the list row", () => {
  const db = memoryAccessDb();
  db.exec(`
    INSERT INTO users (id) VALUES ('alice');
    CREATE TABLE media_tracks (id TEXT PRIMARY KEY);
    CREATE TABLE media_lists (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('playlist', 'queue')),
      title TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT
    );
    CREATE TABLE media_list_items (
      list_id TEXT NOT NULL REFERENCES media_lists(id),
      position INTEGER NOT NULL,
      track_id TEXT NOT NULL REFERENCES media_tracks(id),
      PRIMARY KEY (list_id, position)
    );
    INSERT INTO media_lists (id, kind, title, expires_at)
      VALUES ('q1', 'queue', '播放队列', datetime('now', '-1 hour'));
  `);
  const access = new AccessService(db);
  access.bindOwner("queue", "q1", { kind: "user", id: "alice" });
  assert.equal(access.peek("alice", "queue", "q1").own, true);
  reclaimExpiredQueues(db);
  assert.equal(access.peek("alice", "queue", "q1").read, false);
  assert.deepEqual(
    listBindingsForPrincipal(db, { kind: "user", id: "alice" }),
    [],
  );
});

test("article fetch/open/progress contracts accept a presented capability", () => {
  const token = `c1.${"a".repeat(20)}.${"b".repeat(20)}`;
  const parsed = actionContracts.fetchArticleAction.args.safeParse([
    { articleId: "art-1", capability: token },
  ]);
  assert.equal(parsed.success, true);
  assert.equal(
    actionContracts.fetchArticleSegmentAction.args.safeParse([
      { articleId: "art-1", offset: 0, capability: token },
    ]).success,
    true,
  );
  assert.equal(
    actionContracts.openArticleBundleAction.args.safeParse([
      {
        articleId: "art-1",
        cursor: 0,
        before: 1,
        after: 1,
        capability: token,
      },
    ]).success,
    true,
  );
  assert.equal(
    actionContracts.saveArticleProgressAction.args.safeParse([
      {
        articleId: "art-1",
        offset: 0,
        updatedAt: 1,
        merge: "override",
        capability: token,
      },
    ]).success,
    true,
  );
});

test("bookmarked article list SQL uses favorite rows, not the dropped bookmarks table", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE articles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL,
      provider_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE user_favorites (
      user_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      favorited INTEGER NOT NULL DEFAULT 1,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, resource_kind, resource_id)
    );
    CREATE TABLE article_read_progress (
      user_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      offset INTEGER,
      updated_at_ms INTEGER,
      locator TEXT,
      total_read_seconds INTEGER,
      updated_at TEXT,
      PRIMARY KEY (user_id, article_id)
    );
    CREATE TABLE booklist_items (
      booklist_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      article_id TEXT NOT NULL,
      PRIMARY KEY (booklist_id, position)
    );
    CREATE TABLE group_booklists (
      group_id TEXT PRIMARY KEY,
      booklist_id TEXT NOT NULL
    );
    INSERT INTO articles (id, user_id, title, provider_json)
      VALUES ('a1', 'u1', '一文', '{"type":"text","words":1,"chunks":1}');
    INSERT INTO user_favorites (user_id, resource_kind, resource_id, favorited, updated_at_ms)
      VALUES ('u1', 'article', 'a1', 1, 10);
  `);
  const listed = listArticlesForUser(db, "u1", { view: "bookmarked" });
  assert.equal(listed.articles.length, 1);
  assert.equal(listed.articles[0]?.id, "a1");
});
