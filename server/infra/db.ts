import { Database, default as BetterSQLite3 } from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import { initUpdateManager, isUpdateManagerEnabled } from "./updateManager";
import { initWordSchema } from "@/server/data/words";
import { createWordsService } from "@/server/services/wordsService";
import { DATA_ROOT } from "./env";
import { getRuntimeConfig } from "@/server/infra/runtimeConfig";
import { ADMIN_FEATURE_MASK } from "@/shared/features";
import { splitTextArticle } from "@/shared/articles/segments";

const DB_PATH = path.join(DATA_ROOT, "data.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  _db = new BetterSQLite3(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  initSchema(_db);
  return _db;
}

function initSchema(db: Database) {
  // ── Base tables (always idempotent) ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      handle       TEXT UNIQUE NOT NULL,
      username     TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'user',
      feature_mask INTEGER NOT NULL DEFAULT 126,
      is_muted     INTEGER NOT NULL DEFAULT 0,
      muted_until  TEXT,
      banned_until TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deleted_users (
      id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      username   TEXT NOT NULL,
      deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_pins (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pin_hash   TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
      id              TEXT PRIMARY KEY,
      konami_locked   INTEGER NOT NULL DEFAULT 1,
      persistent      INTEGER NOT NULL DEFAULT 0,
      remark          TEXT NOT NULL DEFAULT '',
      whitelisted     INTEGER NOT NULL DEFAULT 0,
      bound_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS client_ips (
      client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      ip         TEXT NOT NULL,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (client_id, ip)
    );
    CREATE INDEX IF NOT EXISTS idx_client_ips_ip ON client_ips(ip);

    CREATE TABLE IF NOT EXISTS client_associations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      mac        TEXT,
      ip         TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_client_associations_client
      ON client_associations(client_id, last_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_client_associations_ip
      ON client_associations(ip, last_seen DESC);

    CREATE TABLE IF NOT EXISTS client_attempts (
      client_id       TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
      attempts        INTEGER NOT NULL DEFAULT 0,
      throttled_until TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_client ON sessions(client_id);

    CREATE TABLE IF NOT EXISTS groups (
      id              TEXT PRIMARY KEY,
      conv_id         TEXT NOT NULL UNIQUE CHECK (conv_id = 'group:' || id),
      revision        INTEGER NOT NULL DEFAULT 0,
      handle          TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      discoverable    INTEGER NOT NULL DEFAULT 0 CHECK (discoverable IN (0, 1)),
      password_hash   TEXT,
      type            TEXT NOT NULL DEFAULT 'normal',
      members_hidden  INTEGER NOT NULL DEFAULT 0 CHECK (members_hidden IN (0, 1)),
      admin_only      INTEGER NOT NULL DEFAULT 0 CHECK (admin_only IN (0, 1)),
      no_leave        INTEGER NOT NULL DEFAULT 0 CHECK (no_leave IN (0, 1)),
      parent_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_groups_handle ON groups(handle);

    CREATE TABLE IF NOT EXISTS group_members (
      group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
      hide_self  INTEGER NOT NULL DEFAULT 0 CHECK (hide_self IN (0, 1)),
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS dms (
      id             TEXT PRIMARY KEY,
      conv_id        TEXT NOT NULL UNIQUE,
      revision       INTEGER NOT NULL DEFAULT 0,
      peer_a         TEXT NOT NULL,
      peer_b         TEXT NOT NULL,
      proof_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (peer_a < peer_b),
      CHECK (instr(peer_a, ':') = 0 AND instr(peer_b, ':') = 0),
      CHECK (id = peer_a || ':' || peer_b),
      CHECK (conv_id = 'dm:' || id),
      UNIQUE (peer_a, peer_b)
    );

    CREATE TABLE IF NOT EXISTS posts (
      sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
      id           TEXT NOT NULL UNIQUE,
      conv_id      TEXT NOT NULL,
      revision     INTEGER NOT NULL DEFAULT 0,
      author_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      brief        TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL CHECK (json_valid(content_json)),
      reply_to     TEXT REFERENCES posts(id) ON DELETE SET NULL,
      deleted_at   TEXT,
      edited_at    TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((json_extract(content_json, '$.type') = 'deleted') = (deleted_at IS NOT NULL)),
      CHECK (deleted_at IS NULL OR content_json = '{"type":"deleted"}'),
      CHECK (json_extract(content_json, '$.type') != 'text'
        OR content_json = '{"type":"text","text_same_as_brief":true}')
    );

    CREATE TABLE IF NOT EXISTS user_config (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS ghost_users (
      id           TEXT PRIMARY KEY,
      pin_hash     TEXT NOT NULL UNIQUE,
      oobe_token   TEXT UNIQUE,
      oobe_expires TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS articles (
      id            TEXT PRIMARY KEY,
      user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
      group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      provider_json TEXT NOT NULL CHECK (
        json_valid(provider_json) AND
        (COALESCE((json_extract(provider_json, '$.type') = 'text'
          AND json_type(provider_json, '$.words') = 'integer'
          AND json_extract(provider_json, '$.words') >= 0
          AND json_type(provider_json, '$.chunks') = 'integer'
          AND json_extract(provider_json, '$.chunks') >= 0), 0)
        OR COALESCE((json_extract(provider_json, '$.type') = 'blob'
          AND json_type(provider_json, '$.file_name') = 'text'
          AND (json_type(provider_json, '$.bytes') IS NULL
            OR (json_type(provider_json, '$.bytes') = 'integer'
              AND json_extract(provider_json, '$.bytes') >= 0))), 0))
      ),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS text_article_segments (
      article_id    TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
      start_offset  INTEGER NOT NULL CHECK (start_offset >= 0),
      char_count    INTEGER NOT NULL CHECK (char_count BETWEEN 1 AND 10000),
      content       TEXT NOT NULL,
      PRIMARY KEY (article_id, segment_index),
      UNIQUE (article_id, start_offset)
    );
    CREATE INDEX IF NOT EXISTS idx_articles_user ON articles(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_group ON articles(group_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_created_id_group
      ON articles(created_at DESC, id DESC, group_id);

    CREATE TABLE IF NOT EXISTS teach_documents (
      id            TEXT PRIMARY KEY,
      application   TEXT NOT NULL,
      document_type TEXT NOT NULL CHECK (document_type IN ('word', 'powerpoint', 'excel')),
      name          TEXT NOT NULL,
      blob_path     TEXT NOT NULL UNIQUE,
      file_size     INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_teach_documents_created
      ON teach_documents(created_at DESC);

    CREATE TABLE IF NOT EXISTS article_bookmarks (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      bookmarked INTEGER NOT NULL DEFAULT 1,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, article_id)
    );
    CREATE INDEX IF NOT EXISTS idx_article_bookmarks_user_state_created
      ON article_bookmarks(user_id, bookmarked, created_at DESC, article_id DESC);

    CREATE TABLE IF NOT EXISTS article_read_progress (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      offset     INTEGER NOT NULL DEFAULT 0,
      locator    TEXT,
      total_read_seconds INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, article_id)
    );

    CREATE TABLE IF NOT EXISTS client_last_active (
      client_id TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
      last_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS convs_user (
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conv_id           TEXT NOT NULL,
      last_read_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
      pinned_at         TEXT,
      pinned_updated_at_ms INTEGER NOT NULL DEFAULT 0,
      compose_draft     TEXT,
      compose_draft_updated_at INTEGER NOT NULL DEFAULT 0,
      muted             INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
      read_updated_at_ms INTEGER NOT NULL DEFAULT 0,
      muted_updated_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, conv_id)
    );
    CREATE INDEX IF NOT EXISTS idx_convs_user_read_post ON convs_user(last_read_post_id);
  `);

  ensurePinSecret(db);
  ensureConfigDefaults(db);
  initWordSchema(db);
  runMigrations(db);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_clients_bound_user ON clients(bound_user_id)",
  );
  ensureDefaultGroup(db);
  ensureAdminUser(db);
  createWordsService(db).ensureSampleWords();
  if (process.env.NODE_ENV === "production" && isUpdateManagerEnabled()) {
    initUpdateManager(db);
  }
}

const PROD_SCHEMA_VERSION = 14;
const PREVIOUS_SCHEMA_VERSION = 15;
const CURRENT_SCHEMA_VERSION = 16;

export function runMigrations(db: Database) {
  const row = db
    .prepare("SELECT value FROM config WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  if (!row) {
    finalizeSchemaV16(db);
    setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
    return;
  }

  const version = Number.parseInt(row.value, 10);
  if (version === CURRENT_SCHEMA_VERSION) {
    finalizeSchemaV16(db);
    return;
  }
  if (version === PREVIOUS_SCHEMA_VERSION) {
    migrateV15ToV16(db);
    return;
  }
  if (version !== PROD_SCHEMA_VERSION)
    throw new Error(
      `不支持从 Schema v${row.value} 迁移；仅支持生产基线 v${PROD_SCHEMA_VERSION}`,
    );
  migrateProdV14ToV15(db);
  migrateV15ToV16(db);
}

function migrateProdV14ToV15(db: Database) {
  const removed = db.transaction(() => {
    db.exec(`
      ALTER TABLE conversation_user_state
        ADD COLUMN compose_draft_updated_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversation_user_state
        ADD COLUMN pinned_updated_at_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversation_user_state
        ADD COLUMN read_updated_at_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversation_user_state
        ADD COLUMN muted_updated_at_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users
        ADD COLUMN feature_mask INTEGER NOT NULL DEFAULT 62;
      ALTER TABLE users
        ADD COLUMN muted_until TEXT;
      ALTER TABLE user_config
        ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE article_read_progress
        ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE article_bookmarks
        ADD COLUMN bookmarked INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE article_bookmarks
        ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

      UPDATE users SET feature_mask = 63 WHERE role = 'admin';
      UPDATE article_bookmarks
        SET updated_at_ms = CAST(strftime('%s', created_at) AS INTEGER) * 1000;
      UPDATE article_read_progress
        SET updated_at_ms = CAST(strftime('%s', updated_at) AS INTEGER) * 1000;

      INSERT OR IGNORE INTO client_associations
        (client_id, ip, first_seen, last_seen)
        SELECT client_id, ip, first_seen, last_seen FROM client_ips;
    `);
    applyClientManagementV15(db);
    applyArticleCenterV15(db);
    applyTeachDocumentsV15(db);
    const dmPosts = db
      .prepare(
        `DELETE FROM posts
         WHERE user_id IS NULL AND dm_to IS NOT NULL AND group_id IS NULL`,
      )
      .run().changes;
    const dmStates = db
      .prepare(
        `DELETE FROM conversation_user_state
         WHERE conversation_type = 'dm'
           AND NOT EXISTS (
             SELECT 1 FROM users u
             WHERE u.id = conversation_user_state.conversation_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM deleted_users du
             WHERE du.id = conversation_user_state.conversation_id
           )`,
      )
      .run().changes;
    setSchemaVersion(db, PREVIOUS_SCHEMA_VERSION);
    return { dmPosts, dmStates };
  })();

  console.log(
    `[DB] Schema v14 → v15 迁移完成（移除 ${removed.dmPosts} 条幽灵私聊消息、${removed.dmStates} 条孤立私聊状态）`,
  );
}

function tableExists(db: Database, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

function clientColumnNames(db: Database): Set<string> {
  return new Set(
    (db.pragma("table_info(clients)") as { name: string }[]).map(
      (column) => column.name,
    ),
  );
}

/** Final client-management portion of schema v15. Caller owns the transaction. */
function applyClientManagementV15(db: Database): void {
  const columns = clientColumnNames(db);
  const upgradingLegacyClients = !columns.has("persistent");
  const hasLegacyWhitelist = tableExists(db, "client_whitelist");
  const hasLegacyPairing = tableExists(db, "client_pairing_codes");
  if (!columns.has("persistent")) {
    db.exec(
      "ALTER TABLE clients ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!columns.has("remark")) {
    db.exec("ALTER TABLE clients ADD COLUMN remark TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("whitelisted")) {
    db.exec(
      "ALTER TABLE clients ADD COLUMN whitelisted INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!columns.has("bound_user_id")) {
    db.exec(
      "ALTER TABLE clients ADD COLUMN bound_user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
    );
  }

  // v14 had no persistence concept. Its client rows enter v15 as temporary
  // clients and follow the same automatic cleanup policy as newly seen tuples.
  if (upgradingLegacyClients) {
    db.prepare(
      "UPDATE clients SET persistent = 0, whitelisted = 0, bound_user_id = NULL, remark = ''",
    ).run();
  }
  if (upgradingLegacyClients || hasLegacyWhitelist || hasLegacyPairing) {
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('whitelist_enabled', '0')",
    ).run();
  }
  if (hasLegacyWhitelist) {
    db.exec("DROP TABLE client_whitelist");
  }
  if (hasLegacyPairing) {
    db.exec("DROP TABLE client_pairing_codes");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_clients_bound_user ON clients(bound_user_id);
    DELETE FROM config WHERE key IN ('strict_mode', 'pairing_mode');
  `);
}

function columnNames(db: Database, table: string): Set<string> {
  return new Set(
    (db.pragma(`table_info(${table})`) as { name: string }[]).map(
      (column) => column.name,
    ),
  );
}

/** Final article-center portion of schema v15. Caller owns the transaction. */
function applyArticleCenterV15(db: Database): void {
  const posts = columnNames(db, "posts");
  if (posts.has("article_id")) {
    db.exec(`
      UPDATE posts
      SET content_json = '{"type":"text","text_same_as_brief":true}'
      WHERE article_id IS NOT NULL
         OR json_extract(content_json, '$.type') = 'article';
      ALTER TABLE posts DROP COLUMN article_id;
    `);
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_articles_user ON articles(user_id, created_at DESC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_articles_group ON articles(group_id, created_at DESC)",
  );
  const marker = db
    .prepare("SELECT 1 FROM config WHERE key = 'article_center_v15'")
    .get();
  if (!marker) {
    db.exec(`
      UPDATE users SET feature_mask = feature_mask | 64;
      INSERT INTO config (key, value) VALUES ('article_center_v15', '1');
    `);
  }
}

function applyTeachDocumentsV15(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teach_documents (
      id            TEXT PRIMARY KEY,
      application   TEXT NOT NULL,
      document_type TEXT NOT NULL CHECK (document_type IN ('word', 'powerpoint', 'excel')),
      name          TEXT NOT NULL,
      blob_path     TEXT NOT NULL UNIQUE,
      file_size     INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_teach_documents_created
      ON teach_documents(created_at DESC);
  `);
}

interface LegacyArticleV15 {
  id: string;
  user_id: string | null;
  group_id: string;
  title: string;
  content: string;
  content_kind: string;
  blob_path: string | null;
  mime_type: string | null;
  file_size: number;
  original_filename: string | null;
  created_at: string;
}

const ARTICLE_SEGMENT_CHARACTERS = 10_000;

function installConversationSchemaV16(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_groups_handle ON groups(handle);
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id, group_id);
    CREATE INDEX IF NOT EXISTS idx_dms_peer_a ON dms(peer_a, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dms_peer_b ON dms(peer_b, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_conv_sequence ON posts(conv_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_brief ON posts(brief);
    CREATE INDEX IF NOT EXISTS idx_convs_user_read_post ON convs_user(last_read_post_id);

    CREATE TRIGGER IF NOT EXISTS posts_require_conversation_insert
    BEFORE INSERT ON posts BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM groups WHERE conv_id = NEW.conv_id
        UNION ALL
        SELECT 1 FROM dms WHERE conv_id = NEW.conv_id
      ) THEN RAISE(ABORT, 'posts.conv_id does not exist') END;
    END;
    CREATE TRIGGER IF NOT EXISTS posts_bump_conversation_insert
    AFTER INSERT ON posts BEGIN
      UPDATE groups SET revision = revision + 1 WHERE conv_id = NEW.conv_id;
      UPDATE dms SET revision = revision + 1 WHERE conv_id = NEW.conv_id;
      UPDATE posts SET revision = COALESCE(
        (SELECT revision FROM groups WHERE conv_id = NEW.conv_id),
        (SELECT revision FROM dms WHERE conv_id = NEW.conv_id), 0)
      WHERE sequence = NEW.sequence;
    END;
    CREATE TRIGGER IF NOT EXISTS posts_bump_conversation_update
    AFTER UPDATE OF brief, content_json, deleted_at ON posts
    WHEN OLD.brief != NEW.brief OR OLD.content_json != NEW.content_json
      OR OLD.deleted_at IS NOT NEW.deleted_at
    BEGIN
      UPDATE groups SET revision = revision + 1 WHERE conv_id = NEW.conv_id;
      UPDATE dms SET revision = revision + 1 WHERE conv_id = NEW.conv_id;
      UPDATE posts SET revision = COALESCE(
        (SELECT revision FROM groups WHERE conv_id = NEW.conv_id),
        (SELECT revision FROM dms WHERE conv_id = NEW.conv_id), 0)
      WHERE sequence = NEW.sequence;
    END;
    CREATE TRIGGER IF NOT EXISTS posts_require_conversation_update
    BEFORE UPDATE OF conv_id ON posts BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM groups WHERE conv_id = NEW.conv_id
        UNION ALL
        SELECT 1 FROM dms WHERE conv_id = NEW.conv_id
      ) THEN RAISE(ABORT, 'posts.conv_id does not exist') END;
    END;
    CREATE TRIGGER IF NOT EXISTS posts_identity_immutable
    BEFORE UPDATE OF sequence, id, conv_id ON posts BEGIN
      SELECT RAISE(ABORT, 'post identity is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS convs_user_require_conversation_insert
    BEFORE INSERT ON convs_user BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM groups WHERE conv_id = NEW.conv_id
        UNION ALL
        SELECT 1 FROM dms WHERE conv_id = NEW.conv_id
      ) THEN RAISE(ABORT, 'convs_user.conv_id does not exist') END;
    END;
    CREATE TRIGGER IF NOT EXISTS convs_user_require_conversation_update
    BEFORE UPDATE OF conv_id ON convs_user BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM groups WHERE conv_id = NEW.conv_id
        UNION ALL
        SELECT 1 FROM dms WHERE conv_id = NEW.conv_id
      ) THEN RAISE(ABORT, 'convs_user.conv_id does not exist') END;
    END;
    CREATE TRIGGER IF NOT EXISTS groups_identity_immutable
    BEFORE UPDATE OF id, conv_id ON groups BEGIN
      SELECT RAISE(ABORT, 'group conversation identity is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS dms_identity_immutable
    BEFORE UPDATE OF id, conv_id, peer_a, peer_b ON dms BEGIN
      SELECT RAISE(ABORT, 'dm conversation identity is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS groups_delete_conversation
    AFTER DELETE ON groups BEGIN
      DELETE FROM posts WHERE conv_id = OLD.conv_id;
      DELETE FROM convs_user WHERE conv_id = OLD.conv_id;
    END;
    CREATE TRIGGER IF NOT EXISTS dms_delete_conversation
    AFTER DELETE ON dms BEGIN
      DELETE FROM posts WHERE conv_id = OLD.conv_id;
      DELETE FROM convs_user WHERE conv_id = OLD.conv_id;
    END;
  `);
}

function installArticleSchemaV16(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_articles_user ON articles(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_group ON articles(group_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_created_id_group
      ON articles(created_at DESC, id DESC, group_id);
    CREATE INDEX IF NOT EXISTS idx_article_bookmarks_user_state_created
      ON article_bookmarks(user_id, bookmarked, created_at DESC, article_id DESC);
    CREATE INDEX IF NOT EXISTS idx_text_article_segments_offset
      ON text_article_segments(article_id, start_offset);
    CREATE TRIGGER IF NOT EXISTS articles_immutable
    BEFORE UPDATE ON articles BEGIN
      SELECT RAISE(ABORT, 'articles are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS text_article_segments_immutable
    BEFORE UPDATE ON text_article_segments BEGIN
      SELECT RAISE(ABORT, 'article segments are immutable');
    END;
  `);
}

function finalizeSchemaV16(db: Database): void {
  installConversationSchemaV16(db);
  installArticleSchemaV16(db);
}

function migrateV15ToV16(db: Database): void {
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS convs_user;
        DROP TABLE IF EXISTS text_article_segments;
        DROP TABLE IF EXISTS dms;
        DROP TABLE IF EXISTS group_members;

        ALTER TABLE groups RENAME TO groups_v15;
        ALTER TABLE user_groups RENAME TO user_groups_v15;
        ALTER TABLE posts RENAME TO posts_v15;
        ALTER TABLE articles RENAME TO articles_v15;
        ALTER TABLE article_bookmarks RENAME TO article_bookmarks_v15;
        ALTER TABLE article_read_progress RENAME TO article_read_progress_v15;
        ALTER TABLE conversation_user_state RENAME TO conversation_user_state_v15;

        CREATE TABLE groups (
          id              TEXT PRIMARY KEY,
          conv_id         TEXT NOT NULL UNIQUE CHECK (conv_id = 'group:' || id),
          revision        INTEGER NOT NULL DEFAULT 0,
          handle          TEXT NOT NULL UNIQUE,
          name            TEXT NOT NULL,
          discoverable    INTEGER NOT NULL DEFAULT 0 CHECK (discoverable IN (0, 1)),
          password_hash   TEXT,
          type            TEXT NOT NULL DEFAULT 'normal',
          members_hidden  INTEGER NOT NULL DEFAULT 0 CHECK (members_hidden IN (0, 1)),
          admin_only      INTEGER NOT NULL DEFAULT 0 CHECK (admin_only IN (0, 1)),
          no_leave        INTEGER NOT NULL DEFAULT 0 CHECK (no_leave IN (0, 1)),
          parent_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE group_members (
          group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          joined_at TEXT NOT NULL DEFAULT (datetime('now')),
          hide_self INTEGER NOT NULL DEFAULT 0 CHECK (hide_self IN (0, 1)),
          PRIMARY KEY (group_id, user_id)
        );

        CREATE TABLE dms (
          id                    TEXT PRIMARY KEY,
          conv_id               TEXT NOT NULL UNIQUE,
          revision              INTEGER NOT NULL DEFAULT 0,
          peer_a                TEXT NOT NULL,
          peer_b                TEXT NOT NULL,
          proof_group_id        TEXT REFERENCES groups(id) ON DELETE SET NULL,
          created_at            TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (peer_a < peer_b),
          CHECK (instr(peer_a, ':') = 0 AND instr(peer_b, ':') = 0),
          CHECK (id = peer_a || ':' || peer_b),
          CHECK (conv_id = 'dm:' || id),
          UNIQUE (peer_a, peer_b)
        );

        CREATE TABLE posts (
          sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
          id           TEXT NOT NULL UNIQUE,
          conv_id      TEXT NOT NULL,
          revision     INTEGER NOT NULL DEFAULT 0,
          author_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
          brief        TEXT NOT NULL DEFAULT '',
          content_json TEXT NOT NULL CHECK (json_valid(content_json)),
          reply_to     TEXT REFERENCES posts(id) ON DELETE SET NULL,
          deleted_at   TEXT,
          edited_at    TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK ((json_extract(content_json, '$.type') = 'deleted') = (deleted_at IS NOT NULL)),
          CHECK (deleted_at IS NULL OR content_json = '{"type":"deleted"}'),
          CHECK (json_extract(content_json, '$.type') != 'text'
            OR content_json = '{"type":"text","text_same_as_brief":true}')
        );

        CREATE TABLE convs_user (
          user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          conv_id                  TEXT NOT NULL,
          last_read_post_id        TEXT REFERENCES posts(id) ON DELETE SET NULL,
          pinned_at                TEXT,
          pinned_updated_at_ms     INTEGER NOT NULL DEFAULT 0,
          compose_draft            TEXT,
          compose_draft_updated_at INTEGER NOT NULL DEFAULT 0,
          muted                    INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
          read_updated_at_ms       INTEGER NOT NULL DEFAULT 0,
          muted_updated_at_ms      INTEGER NOT NULL DEFAULT 0,
          updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, conv_id)
        );

        CREATE TABLE articles (
          id            TEXT PRIMARY KEY,
          user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
          group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          title         TEXT NOT NULL,
          provider_json TEXT NOT NULL CHECK (
            json_valid(provider_json) AND
            (COALESCE((json_extract(provider_json, '$.type') = 'text'
              AND json_type(provider_json, '$.words') = 'integer'
              AND json_extract(provider_json, '$.words') >= 0
              AND json_type(provider_json, '$.chunks') = 'integer'
              AND json_extract(provider_json, '$.chunks') >= 0), 0)
            OR COALESCE((json_extract(provider_json, '$.type') = 'blob'
              AND json_type(provider_json, '$.file_name') = 'text'
              AND (json_type(provider_json, '$.bytes') IS NULL
                OR (json_type(provider_json, '$.bytes') = 'integer'
                  AND json_extract(provider_json, '$.bytes') >= 0))), 0))
          ),
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE text_article_segments (
          article_id   TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
          segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
          start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
          char_count   INTEGER NOT NULL CHECK (char_count BETWEEN 1 AND 10000),
          content      TEXT NOT NULL,
          PRIMARY KEY (article_id, segment_index),
          UNIQUE (article_id, start_offset)
        );

        CREATE TABLE article_bookmarks (
          user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          article_id   TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          bookmarked   INTEGER NOT NULL DEFAULT 1,
          updated_at_ms INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, article_id)
        );

        CREATE TABLE article_read_progress (
          user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          article_id        TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
          offset            INTEGER NOT NULL DEFAULT 0,
          locator           TEXT,
          total_read_seconds INTEGER NOT NULL DEFAULT 0,
          updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at_ms     INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, article_id)
        );

        INSERT INTO groups
          (id, conv_id, handle, name, discoverable, password_hash, type,
           members_hidden, admin_only, no_leave, parent_group_id, created_at)
        SELECT id, 'group:' || id, COALESCE(handle, id), name, discoverable,
               password_hash, type, members_hidden, admin_only, no_leave,
               parent_group_id, created_at
        FROM groups_v15;

        INSERT INTO group_members (group_id, user_id, joined_at, hide_self)
        SELECT group_id, user_id, joined_at, hide_self FROM user_groups_v15;

        INSERT OR IGNORE INTO dms (id, conv_id, peer_a, peer_b, proof_group_id, created_at)
        SELECT
          CASE WHEN user_id < dm_to THEN user_id || ':' || dm_to ELSE dm_to || ':' || user_id END,
          'dm:' || CASE WHEN user_id < dm_to THEN user_id || ':' || dm_to ELSE dm_to || ':' || user_id END,
          CASE WHEN user_id < dm_to THEN user_id ELSE dm_to END,
          CASE WHEN user_id < dm_to THEN dm_to ELSE user_id END,
          NULL,
          MIN(created_at)
        FROM posts_v15
        WHERE user_id IS NOT NULL AND dm_to IS NOT NULL AND user_id != dm_to
        GROUP BY 1, 2, 3, 4;
      `);

      const invalidPosts = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM posts_v15
             WHERE NOT (
               (group_id IS NOT NULL AND dm_to IS NULL)
               OR (group_id IS NULL AND dm_to IS NOT NULL AND user_id IS NOT NULL AND user_id != dm_to)
             )`,
          )
          .get() as { n: number }
      ).n;
      if (invalidPosts !== 0) {
        throw new Error(
          `Schema v16 migration found ${invalidPosts} posts with an invalid target`,
        );
      }

      db.exec(`
        INSERT INTO posts
          (sequence, id, conv_id, author_id, brief, content_json, reply_to,
           deleted_at, edited_at, created_at)
        SELECT rowid, id,
          CASE WHEN group_id IS NOT NULL THEN 'group:' || group_id
               ELSE 'dm:' || CASE WHEN user_id < dm_to
                 THEN user_id || ':' || dm_to ELSE dm_to || ':' || user_id END END,
          user_id,
          CASE
            WHEN is_deleted = 1 THEN ''
            WHEN json_extract(content_json, '$.type') = 'text'
              THEN COALESCE(json_extract(content_json, '$.text'), brief, content, '')
            ELSE COALESCE(brief, '')
          END,
          CASE
            WHEN is_deleted = 1 THEN '{"type":"deleted"}'
            WHEN json_extract(content_json, '$.type') = 'text'
              THEN '{"type":"text","text_same_as_brief":true}'
            WHEN json_valid(content_json) THEN content_json
            ELSE '{"type":"text","text_same_as_brief":true}'
          END,
          reply_to,
          CASE WHEN is_deleted = 1 THEN COALESCE(deleted_at, created_at) ELSE NULL END,
          edited_at, created_at
        FROM posts_v15 ORDER BY rowid;
      `);

      const articles = db
        .prepare(
          `SELECT id, user_id, group_id, title, content, content_kind, blob_path,
                  mime_type, file_size, original_filename, created_at
           FROM articles_v15 ORDER BY created_at, id`,
        )
        .all() as LegacyArticleV15[];
      const insertArticle = db.prepare(
        `INSERT INTO articles
           (id, user_id, group_id, title, provider_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertSegment = db.prepare(
        `INSERT INTO text_article_segments
           (article_id, segment_index, start_offset, char_count, content)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const article of articles) {
        if (article.content_kind === "blob") {
          insertArticle.run(
            article.id,
            article.user_id,
            article.group_id,
            article.title,
            JSON.stringify({
              type: "blob",
              file_name: article.blob_path ?? "",
              mime_type: article.mime_type,
              bytes: article.file_size,
              original_name: article.original_filename,
            }),
            article.created_at,
          );
          continue;
        }
        const text = article.content ?? "";
        const segments = splitTextArticle(text, ARTICLE_SEGMENT_CHARACTERS);
        insertArticle.run(
          article.id,
          article.user_id,
          article.group_id,
          article.title,
          JSON.stringify({
            type: "text",
            words: text.length,
            chunks: segments.length,
          }),
          article.created_at,
        );
        for (const segment of segments) {
          insertSegment.run(
            article.id,
            segment.index,
            segment.startOffset,
            segment.content.length,
            segment.content,
          );
        }
      }

      db.exec(`
        INSERT INTO article_bookmarks
          (user_id, article_id, created_at, bookmarked, updated_at_ms)
        SELECT user_id, article_id, created_at, bookmarked, updated_at_ms
        FROM article_bookmarks_v15;

        INSERT INTO article_read_progress
          (user_id, article_id, offset, locator, total_read_seconds, updated_at, updated_at_ms)
        SELECT user_id, article_id, offset, locator, total_read_seconds, updated_at, updated_at_ms
        FROM article_read_progress_v15;

        INSERT INTO convs_user
          (user_id, conv_id, last_read_post_id, pinned_at, pinned_updated_at_ms,
           compose_draft, compose_draft_updated_at, muted, read_updated_at_ms,
           muted_updated_at_ms, updated_at)
        SELECT s.user_id,
          CASE WHEN s.conversation_type = 'group'
            THEN 'group:' || s.conversation_id
            ELSE 'dm:' || CASE WHEN s.user_id < s.conversation_id
              THEN s.user_id || ':' || s.conversation_id
              ELSE s.conversation_id || ':' || s.user_id END END,
          CASE WHEN EXISTS (SELECT 1 FROM posts p WHERE p.id = s.last_read_post_id)
            THEN s.last_read_post_id ELSE NULL END,
          s.pinned_at, s.pinned_updated_at_ms, s.compose_draft,
          s.compose_draft_updated_at, s.muted, s.read_updated_at_ms,
          s.muted_updated_at_ms, s.updated_at
        FROM conversation_user_state_v15 s
        WHERE (s.conversation_type = 'group' AND EXISTS (
                 SELECT 1 FROM groups g WHERE g.id = s.conversation_id))
           OR (s.conversation_type = 'dm' AND EXISTS (
                 SELECT 1 FROM dms d
                 WHERE d.peer_a = MIN(s.user_id, s.conversation_id)
                   AND d.peer_b = MAX(s.user_id, s.conversation_id)));

        CREATE TEMP TABLE v16_post_revisions (
          sequence INTEGER PRIMARY KEY,
          revision INTEGER NOT NULL
        );
        INSERT INTO v16_post_revisions (sequence, revision)
        SELECT sequence,
          ROW_NUMBER() OVER (PARTITION BY conv_id ORDER BY sequence)
        FROM posts;
        UPDATE posts SET revision = (
          SELECT revision FROM v16_post_revisions r
          WHERE r.sequence = posts.sequence
        );
        UPDATE groups SET revision = COALESCE(
          (SELECT MAX(p.revision) FROM posts p WHERE p.conv_id = groups.conv_id),
          0
        );
        UPDATE dms SET revision = COALESCE(
          (SELECT MAX(p.revision) FROM posts p WHERE p.conv_id = dms.conv_id),
          0
        );
        DROP TABLE v16_post_revisions;

        DROP TABLE conversation_user_state_v15;
        DROP TABLE posts_v15;
        DROP TABLE article_bookmarks_v15;
        DROP TABLE article_read_progress_v15;
        DROP TABLE articles_v15;
        DROP TABLE user_groups_v15;
        DROP TABLE groups_v15;
      `);

      installConversationSchemaV16(db);
      installArticleSchemaV16(db);

      const segmentViolation = db
        .prepare(
          `SELECT 1 FROM text_article_segments
           WHERE char_count < 1 OR char_count > ? LIMIT 1`,
        )
        .get(ARTICLE_SEGMENT_CHARACTERS);
      if (segmentViolation)
        throw new Error("Schema v16 article segment validation failed");
      setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
    })();
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }

  const foreignKeyErrors = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length) {
    throw new Error(
      `Schema v16 foreign-key validation failed (${foreignKeyErrors.length} rows)`,
    );
  }
  console.log("[DB] Schema v15 → v16 迁移完成（统一会话、墓碑消息与文章分片）");
}

function setSchemaVersion(db: Database, version: number) {
  db.prepare(
    "INSERT OR REPLACE INTO config (key, value) VALUES ('schema_version', ?)",
  ).run(String(version));
}

// ── Seed helpers ──────────────────────────────────────────────────────────────
function ensureConfigDefaults(db: Database) {
  db.exec(`
    INSERT OR IGNORE INTO config (key, value) VALUES ('system_locked', '0');
    INSERT OR IGNORE INTO config (key, value) VALUES ('idle_lock_enabled', '0');
    INSERT OR IGNORE INTO config (key, value) VALUES ('whitelist_enabled', '0');
    INSERT OR IGNORE INTO config (key, value) VALUES ('client_identity_methods', 'mac,user_agent');
    INSERT OR IGNORE INTO config (key, value) VALUES ('announcement_content', '');
    INSERT OR IGNORE INTO config (key, value) VALUES ('announcement_revision', '0');
  `);
}

function ensurePinSecret(db: Database) {
  const row = db
    .prepare("SELECT value FROM config WHERE key = 'pin_secret'")
    .get() as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "pin_secret",
      crypto.randomBytes(32).toString("hex"),
    );
  }
}

export function getPinSecret(db: Database): string {
  return (
    db.prepare("SELECT value FROM config WHERE key = 'pin_secret'").get() as {
      value: string;
    }
  ).value;
}

function ensureDefaultGroup(db: Database) {
  if (!db.prepare("SELECT 1 FROM groups WHERE type = 'wild' LIMIT 1").get()) {
    db.prepare(
      `INSERT INTO groups (id, conv_id, handle, name, discoverable, type, no_leave)
       VALUES ('wild', 'group:wild', 'wild', '大别野', 0, 'wild', 1)`,
    ).run();
  }
  if (
    !db
      .prepare("SELECT 1 FROM groups WHERE type = 'announcement' LIMIT 1")
      .get()
  ) {
    db.prepare(
      `INSERT INTO groups (id, conv_id, handle, name, discoverable, type, members_hidden, admin_only, no_leave)
       VALUES ('announcement', 'group:announcement', 'announcement', '公告', 0, 'announcement', 1, 1, 1)`,
    ).run();
  }

  // 每种特殊类型只保留一个
  for (const type of ["wild", "announcement"] as const) {
    const rows = db
      .prepare("SELECT id FROM groups WHERE type = ? ORDER BY created_at ASC")
      .all(type) as { id: string }[];
    for (let i = 1; i < rows.length; i++) {
      db.prepare("UPDATE groups SET type = 'normal' WHERE id = ?").run(
        rows[i].id,
      );
    }
  }

  db.prepare(
    `INSERT OR IGNORE INTO group_members (user_id, group_id)
     SELECT u.id, g.id FROM users u
     CROSS JOIN groups g
     LEFT JOIN deleted_users du ON du.id = u.id
     WHERE g.type = 'announcement' AND du.id IS NULL`,
  ).run();

  const wildId = db
    .prepare(
      "SELECT id FROM groups WHERE type = 'wild' ORDER BY created_at ASC LIMIT 1",
    )
    .get() as { id: string } | undefined;
  if (wildId) {
    db.prepare(
      `UPDATE groups SET parent_group_id = ?
       WHERE type = 'normal' AND discoverable = 1 AND parent_group_id IS NULL AND id != ?`,
    ).run(wildId.id, wildId.id);
  }
}

function ensureAdminUser(db: Database) {
  const existing = db
    .prepare("SELECT id FROM users WHERE (feature_mask & 1) != 0 LIMIT 1")
    .get();
  if (existing) return;

  const runtimeInitialPin = getRuntimeConfig().initialAdminPin;
  const pin =
    runtimeInitialPin !== undefined
      ? runtimeInitialPin
      : String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  const id = crypto.randomUUID();
  const pinHash = crypto
    .createHmac("sha256", getPinSecret(db))
    .update(pin)
    .digest("hex");

  db.transaction(() => {
    db.prepare(
      "INSERT INTO users (id, handle, username, role, feature_mask) VALUES (?, 'admin', '管理员', 'admin', ?)",
    ).run(id, ADMIN_FEATURE_MASK);
    db.prepare(
      "INSERT INTO user_pins (id, user_id, pin_hash) VALUES (?, ?, ?)",
    ).run(crypto.randomUUID(), id, pinHash);
    db.prepare(
      `INSERT OR IGNORE INTO group_members (user_id, group_id)
       SELECT ?, id FROM groups WHERE type IN ('wild', 'announcement')`,
    ).run(id);
  })();

  console.log("\n============================================");
  console.log("  首次启动 — 管理员 PIN 码：" + pin);
  console.log("  请妥善保管，此信息不会再次显示");
  console.log("============================================\n");
}
