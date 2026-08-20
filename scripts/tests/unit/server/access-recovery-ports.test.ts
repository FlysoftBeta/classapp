import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { collectionsContainingTrack } from "@/server/data/media";
import {
  addBooklistItem,
  attachGroupBooklist,
  collectionsContainingArticle,
  createBooklistRow,
  findGroupBooklistId,
} from "@/server/data/booklists";

function mediaDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE media_tracks (id TEXT PRIMARY KEY);
    CREATE TABLE media_lists (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('playlist', 'queue')),
      title TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE media_list_items (
      list_id TEXT NOT NULL REFERENCES media_lists(id),
      position INTEGER NOT NULL,
      track_id TEXT NOT NULL REFERENCES media_tracks(id),
      PRIMARY KEY (list_id, position)
    );
  `);
  return db;
}

function articleDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE articles (id TEXT PRIMARY KEY);
    CREATE TABLE booklists (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE booklist_items (
      booklist_id TEXT NOT NULL REFERENCES booklists(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      article_id TEXT NOT NULL REFERENCES articles(id),
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (booklist_id, position)
    );
    CREATE TABLE group_booklists (
      group_id TEXT PRIMARY KEY REFERENCES groups(id),
      booklist_id TEXT NOT NULL UNIQUE REFERENCES booklists(id)
    );
  `);
  return db;
}

test("track containment recovery is a media-list lookup, not access SQL", () => {
  const db = mediaDb();
  db.exec(`
    INSERT INTO media_tracks (id) VALUES ('t1');
    INSERT INTO media_lists (id, kind, revision) VALUES ('p1', 'playlist', 4);
    INSERT INTO media_list_items (list_id, position, track_id) VALUES ('p1', 0, 't1');
  `);
  assert.deepEqual(collectionsContainingTrack(db, "t1"), [
    { kind: "playlist", id: "p1", revision: 4 },
  ]);
  assert.deepEqual(collectionsContainingTrack(db, "missing"), []);
});

test("article containment and group association live on booklists, not media_lists", () => {
  const db = articleDb();
  db.exec(`
    INSERT INTO groups (id, name) VALUES ('g1', '一年级');
    INSERT INTO articles (id) VALUES ('a1');
  `);
  const listId = createBooklistRow(db, "群组文单");
  attachGroupBooklist(db, "g1", listId);
  addBooklistItem(db, listId, "a1");
  assert.equal(findGroupBooklistId(db, "g1"), listId);
  const containing = collectionsContainingArticle(db, "a1");
  assert.equal(containing.length, 1);
  assert.equal(containing[0]?.kind, "booklist");
  assert.equal(containing[0]?.id, listId);
});
