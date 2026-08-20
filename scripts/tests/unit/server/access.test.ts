import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { AccessService } from "@/server/services/accessService";
import {
  OwnerlessCapabilityService,
  type OwnerlessRecovery,
} from "@/server/services/ownerlessCapability";
import { AuthorizationError } from "@/server/services/authorizationError";
import { CapabilityService } from "@/server/services/capabilityService";
import { upsertAccessBinding } from "@/server/data/access";
import { listFavoriteIds, upsertFavorite } from "@/server/data/preferences";
import {
  flagsCanIssue,
  flagsOfGrantSet,
  collectionSource,
  type AccessGrant,
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
    CREATE TABLE user_favorites (
      user_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      favorited INTEGER NOT NULL DEFAULT 1,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, resource_kind, resource_id)
    );
    CREATE TABLE user_recents (
      user_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, resource_kind, resource_id)
    );
  `);
  return db;
}

function owned(db: Database.Database) {
  return new AccessService(db);
}

function ownerless(
  db: Database.Database,
  recovery?: OwnerlessRecovery,
) {
  return new OwnerlessCapabilityService(
    db,
    new CapabilityService("test-secret"),
    owned(db),
    recovery,
  );
}

test("owner binding materializes full flags and authorizes write", () => {
  const db = memoryAccessDb();
  db.prepare("INSERT INTO users (id) VALUES (?)").run("alice");
  const access = owned(db);
  access.bindOwner("playlist", "list-1", { kind: "user", id: "alice" });
  const auth = access.authorize("alice", "playlist", "list-1", "write");
  assert.equal(auth.flags.own, true);
  assert.equal(auth.flags.shareOwn, true);
  assert.equal(auth.recovered, false);
});

test("non-shareable holder cannot grant; shareable read cannot escalate", () => {
  const db = memoryAccessDb();
  db.exec(`INSERT INTO users (id) VALUES ('alice'), ('bob'), ('carol')`);
  const access = owned(db);
  access.bindOwner("playlist", "list-1", { kind: "user", id: "alice" });
  access.grant("alice", "playlist", "list-1", { kind: "user", id: "bob" }, {
    mode: "readwrite",
    shareable: false,
  });
  assert.throws(
    () =>
      access.grant("bob", "playlist", "list-1", { kind: "user", id: "carol" }, {
        mode: "read",
        shareable: false,
      }),
    (error: unknown) => error instanceof AuthorizationError,
  );
  access.grant("alice", "playlist", "list-1", { kind: "user", id: "bob" }, {
    mode: "read",
    shareable: true,
  });
  assert.throws(
    () =>
      access.grant("bob", "playlist", "list-1", { kind: "user", id: "carol" }, {
        mode: "readwrite",
        shareable: false,
      }),
    (error: unknown) => error instanceof AuthorizationError,
  );
  access.grant("bob", "playlist", "list-1", { kind: "user", id: "carol" }, {
    mode: "read",
    shareable: false,
  });
  const carol = access.peek("carol", "playlist", "list-1");
  assert.equal(carol.read, true);
  assert.equal(carol.write, false);
  assert.equal(carol.shareRead, false);
});

test("union of shareable-read and held-write does not authorize granting write", () => {
  const db = memoryAccessDb();
  db.exec(`
    INSERT INTO users (id) VALUES ('alice'), ('bob'), ('carol');
    INSERT INTO groups (id) VALUES ('g1');
    INSERT INTO group_members (group_id, user_id) VALUES ('g1', 'bob');
  `);
  const access = owned(db);
  access.bindOwner("playlist", "list-1", { kind: "user", id: "alice" });
  access.grant("alice", "playlist", "list-1", { kind: "user", id: "bob" }, {
    mode: "readwrite",
    shareable: false,
  });
  access.grant("alice", "playlist", "list-1", { kind: "group", id: "g1" }, {
    mode: "read",
    shareable: true,
  });
  const flags = access.peek("bob", "playlist", "list-1");
  assert.equal(flags.read, true);
  assert.equal(flags.write, true);
  assert.equal(flags.shareRead, true);
  assert.equal(flagsCanIssue(flags, { mode: "readwrite", shareable: false }), false);
  assert.throws(
    () =>
      access.grant("bob", "playlist", "list-1", { kind: "user", id: "carol" }, {
        mode: "readwrite",
        shareable: false,
      }),
    (error: unknown) => error instanceof AuthorizationError,
  );
});

test("leaving a group drops group-derived access unless another path remains", () => {
  const db = memoryAccessDb();
  db.exec(`
    INSERT INTO users (id) VALUES ('alice'), ('bob');
    INSERT INTO groups (id) VALUES ('g1');
    INSERT INTO group_members (group_id, user_id) VALUES ('g1', 'bob');
  `);
  const access = owned(db);
  access.bindOwner("playlist", "group-list", { kind: "group", id: "g1" });
  assert.equal(access.peek("bob", "playlist", "group-list").read, true);
  db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(
    "g1",
    "bob",
  );
  access.onGroupMembershipChanged("bob", "g1");
  assert.equal(access.peek("bob", "playlist", "group-list").read, false);
  assert.throws(
    () => access.authorize("bob", "playlist", "group-list", "read"),
    (error: unknown) => error instanceof AuthorizationError,
  );

  db.prepare("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)").run(
    "g1",
    "bob",
  );
  access.bindOwner("playlist", "personal", { kind: "user", id: "bob" });
  access.onGroupMembershipChanged("bob", "g1");
  db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(
    "g1",
    "bob",
  );
  access.onGroupMembershipChanged("bob", "g1");
  assert.equal(access.peek("bob", "playlist", "personal").own, true);
  assert.equal(access.peek("bob", "playlist", "group-list").read, false);
});

test("favoriting does not create an independent access binding", () => {
  const db = memoryAccessDb();
  db.exec(`
    INSERT INTO users (id) VALUES ('alice'), ('bob');
    INSERT INTO groups (id) VALUES ('g1');
    INSERT INTO group_members (group_id, user_id) VALUES ('g1', 'bob');
  `);
  const access = owned(db);
  access.bindOwner("playlist", "list-1", { kind: "group", id: "g1" });
  upsertFavorite(db, "bob", "playlist", "list-1", true, Date.now());
  db.prepare("DELETE FROM group_members WHERE user_id = ?").run("bob");
  access.onGroupMembershipChanged("bob", "g1");
  assert.deepEqual(listFavoriteIds(db, "bob", "playlist"), ["list-1"]);
  assert.equal(access.peek("bob", "playlist", "list-1").read, false);
  assert.throws(
    () => access.authorize("bob", "playlist", "list-1", "read"),
    (error: unknown) => error instanceof AuthorizationError,
  );
});

test("materialized miss recovers from live bindings without rediscovery", () => {
  const db = memoryAccessDb();
  db.prepare("INSERT INTO users (id) VALUES (?)").run("alice");
  const access = owned(db);
  access.bindOwner("notebook", "b1", { kind: "user", id: "alice" });
  db.prepare(
    "DELETE FROM access_effective WHERE user_id = ? AND resource_id = ?",
  ).run("alice", "b1");
  const auth = access.authorize("alice", "notebook", "b1", "own");
  assert.equal(auth.recovered, true);
  assert.equal(auth.flags.own, true);
});

test("capability HMAC verification rejects tamper, expiry, and kind mismatch", () => {
  const capabilities = new CapabilityService("secret");
  const token = capabilities.sign("track", "t1", { type: "search" }, 1_000);
  assert.equal(capabilities.verify(token, { kind: "track", id: "t1" }, 1_001).ok, true);
  assert.equal(
    capabilities.verify(token, { kind: "track", id: "t1" }, 1_000 + 25 * 60 * 60 * 1000)
      .ok,
    false,
  );
  const parts = token.split(".");
  const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}aa`;
  assert.equal(
    capabilities.verify(tampered, { kind: "track", id: "t1" }, 1_001).ok,
    false,
  );
  assert.equal(
    capabilities.verify(token, { kind: "article", id: "t1" }, 1_001).ok,
    false,
  );
});

test("held ownerless capability authorizes without owned access or recovery", () => {
  const db = memoryAccessDb();
  db.exec(`INSERT INTO users (id) VALUES ('alice')`);
  let recoveryAsked = false;
  const capabilities = ownerless(db, {
    collectionsContaining() {
      recoveryAsked = true;
      return [];
    },
  });
  const token = capabilities.issue("track", "t1", { type: "search" });
  capabilities.remember("alice", "track", "t1", token);
  const held = capabilities.require("alice", "track", "t1");
  assert.equal(held.recovered, false);
  assert.equal(held.capability, token);
  assert.equal(recoveryAsked, false);
  assert.equal(owned(db).peek("alice", "track", "t1").read, false);
});

test("expired ownerless capability recovers through a still-readable collection", () => {
  const db = memoryAccessDb();
  db.exec(`INSERT INTO users (id) VALUES ('alice')`);
  owned(db).bindOwner("playlist", "p1", { kind: "user", id: "alice" });
  const capabilities = ownerless(db, {
    collectionsContaining(kind, id) {
      if (kind === "track" && id === "t1") {
        return [{ kind: "playlist", id: "p1", revision: 1 }];
      }
      return [];
    },
  });
  const expired = capabilities.issue("track", "t1", { type: "search" }, 1);
  const recovered = capabilities.require(
    "alice",
    "track",
    "t1",
    expired,
    Date.now(),
  );
  assert.equal(recovered.recovered, true);
  assert.match(recovered.capability, /^c1\./);
  const again = capabilities.require("alice", "track", "t1");
  assert.equal(again.recovered, false);
});

test("expired ownerless capability does not recover from an unreadable collection", () => {
  const db = memoryAccessDb();
  db.exec(`INSERT INTO users (id) VALUES ('alice'), ('bob')`);
  owned(db).bindOwner("playlist", "p1", { kind: "user", id: "bob" });
  const capabilities = ownerless(db, {
    collectionsContaining() {
      return [{ kind: "playlist", id: "p1" }];
    },
  });
  const expired = capabilities.issue("track", "t1", { type: "search" }, 1);
  assert.throws(
    () => capabilities.require("alice", "track", "t1", expired, Date.now()),
    (error: unknown) =>
      error instanceof AuthorizationError && error.code === "expired_capability",
  );
});

test("leaving a group keeps access when a personal binding remains on the same list", () => {
  const db = memoryAccessDb();
  db.exec(`
    INSERT INTO users (id) VALUES ('alice'), ('bob');
    INSERT INTO groups (id) VALUES ('g1');
    INSERT INTO group_members (group_id, user_id) VALUES ('g1', 'bob');
  `);
  const access = owned(db);
  access.bindOwner("playlist", "shared", { kind: "user", id: "alice" });
  access.grant("alice", "playlist", "shared", { kind: "group", id: "g1" }, {
    mode: "read",
    shareable: false,
  });
  access.grant("alice", "playlist", "shared", { kind: "user", id: "bob" }, {
    mode: "read",
    shareable: false,
  });
  assert.equal(access.peek("bob", "playlist", "shared").read, true);
  db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(
    "g1",
    "bob",
  );
  access.onGroupMembershipChanged("bob", "g1");
  const auth = access.authorize("bob", "playlist", "shared", "read");
  assert.equal(auth.flags.read, true);
  assert.equal(auth.flags.own, false);
});

test("authorize rematerializes on miss without the UI rediscovering the path", () => {
  const db = memoryAccessDb();
  db.exec(`INSERT INTO users (id) VALUES ('alice')`);
  const access = owned(db);
  upsertAccessBinding(
    db,
    "playlist",
    "list-1",
    { kind: "user", id: "alice" },
    [{ mode: "owner" }],
  );
  const auth = access.authorize("alice", "playlist", "list-1", "own");
  assert.equal(auth.flags.own, true);
  assert.equal(auth.recovered, true);
});

test("grant to an unknown principal is rejected", () => {
  const db = memoryAccessDb();
  db.exec(`INSERT INTO users (id) VALUES ('alice')`);
  const access = owned(db);
  access.bindOwner("playlist", "list-1", { kind: "user", id: "alice" });
  assert.throws(
    () =>
      access.grant("alice", "playlist", "list-1", { kind: "user", id: "ghost" }, {
        mode: "read",
        shareable: false,
      }),
    (error: unknown) =>
      error instanceof AuthorizationError && error.code === "not_found",
  );
});

test("joining a group rematerializes group-owned lists for the member", () => {
  const db = memoryAccessDb();
  db.exec(`
    INSERT INTO users (id) VALUES ('alice'), ('bob');
    INSERT INTO groups (id) VALUES ('g1');
  `);
  const access = owned(db);
  access.bindOwner("booklist", "bl1", { kind: "group", id: "g1" });
  assert.equal(access.peek("bob", "booklist", "bl1").read, false);
  db.prepare("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)").run(
    "g1",
    "bob",
  );
  access.onGroupMembershipChanged("bob", "g1");
  assert.equal(access.peek("bob", "booklist", "bl1").own, true);
});

test("collection capability source is domain-opaque", () => {
  const capabilities = new CapabilityService("secret");
  const token = capabilities.sign(
    "article",
    "a1",
    collectionSource("booklist", "b1", 3),
    1_000,
  );
  const verified = capabilities.verify(token, { kind: "article", id: "a1" }, 1_001);
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.payload.src.type, "collection");
    if (verified.payload.src.type === "collection") {
      assert.equal(verified.payload.src.kind, "booklist");
      assert.equal(verified.payload.src.id, "b1");
    }
  }
});

test("effective grant set for mixed paths stays a union, not a synthesized shareable write", () => {
  const grants: AccessGrant[] = [
    { mode: "read", shareable: true },
    { mode: "readwrite", shareable: false },
  ];
  const flags = flagsOfGrantSet(grants);
  assert.equal(flags.write, true);
  assert.equal(flags.shareWrite, false);
});
