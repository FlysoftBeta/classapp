import { Database, default as BetterSQLite3 } from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import { initWordSchema } from "@/server/data/words";
import { createWordsService } from "@/server/services/wordsService";
import { DATA_ROOT } from "./env";
import { runtimeConfig } from "@/server/infra/runtimeConfig";
import { ADMIN_FEATURE_MASK } from "@/shared/features";

const DB_PATH = path.join(DATA_ROOT, "data.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  _db = new BetterSQLite3(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  initializeDatabase(_db);
  return _db;
}

const BASELINE_SCHEMA_VERSION = 17;
const CURRENT_SCHEMA_VERSION = 18;

type SchemaMigration = (db: Database) => void;

const INCIDENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS incident_groups (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    environment         TEXT NOT NULL CHECK (environment IN ('server', 'client')),
    build_id            TEXT NOT NULL,
    fingerprint         TEXT NOT NULL,
    top_frame           TEXT NOT NULL,
    occurrence_count    INTEGER NOT NULL DEFAULT 0,
    stored_detail_count INTEGER NOT NULL DEFAULT 0,
    first_at            TEXT NOT NULL,
    last_at             TEXT NOT NULL,
    UNIQUE (environment, build_id, fingerprint)
  );
  CREATE INDEX IF NOT EXISTS idx_incident_groups_last_at
    ON incident_groups(last_at DESC);
  CREATE INDEX IF NOT EXISTS idx_incident_groups_filter
    ON incident_groups(environment, build_id, last_at DESC);

  CREATE TABLE IF NOT EXISTS incidents (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id                TEXT UNIQUE,
    group_id                 INTEGER NOT NULL REFERENCES incident_groups(id) ON DELETE CASCADE,
    occurred_at              TEXT NOT NULL,
    error_name               TEXT,
    message                  TEXT,
    stack                    TEXT,
    context_json             TEXT CHECK (context_json IS NULL OR json_valid(context_json)),
    related_incident_ids_json TEXT CHECK (
      related_incident_ids_json IS NULL OR json_valid(related_incident_ids_json)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_incidents_group
    ON incidents(group_id, id DESC);
`;

const MIGRATIONS = new Map<number, SchemaMigration>([
  [17, (db) => db.exec(INCIDENT_SCHEMA)],
]);

/** Prepare the version ledger and apply every ordered migration transactionally. */
function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const row = db
    .prepare("SELECT value FROM config WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  if (!row) {
    db.prepare(
      "INSERT INTO config (key, value) VALUES ('schema_version', ?)",
    ).run(String(CURRENT_SCHEMA_VERSION));
    return;
  }

  let version = Number.parseInt(row.value, 10);
  if (
    !Number.isSafeInteger(version) ||
    version < BASELINE_SCHEMA_VERSION ||
    version > CURRENT_SCHEMA_VERSION
  ) {
    throw new Error(
      `不支持 Schema v${row.value}；当前数据库基线是 v${BASELINE_SCHEMA_VERSION}`,
    );
  }

  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS.get(version);
    if (!migration) {
      throw new Error(`缺少 Schema v${version} → v${version + 1} 迁移`);
    }
    const nextVersion = version + 1;
    db.transaction(() => {
      migration(db);
      db.prepare(
        "UPDATE config SET value = ? WHERE key = 'schema_version'",
      ).run(String(nextVersion));
    })();
    version = nextVersion;
  }
}

/** Install the complete current schema; all declarations are idempotent. */
function installSchema(db: Database): void {
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
        OR COALESCE((json_extract(provider_json, '$.type') = 'bundle'
          AND json_type(provider_json, '$.source_file') = 'text'
          AND json_type(provider_json, '$.archive_file') = 'text'
          AND json_type(provider_json, '$.source_mime') = 'text'
          AND json_type(provider_json, '$.source_bytes') = 'integer'
          AND json_extract(provider_json, '$.source_bytes') >= 0
          AND json_type(provider_json, '$.archive_bytes') = 'integer'
          AND json_extract(provider_json, '$.archive_bytes') >= 0
          AND json_type(provider_json, '$.items') = 'integer'
          AND json_extract(provider_json, '$.items') >= 0), 0))
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

  db.exec(INCIDENT_SCHEMA);

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

function initializeDatabase(db: Database): void {
  runMigrations(db);
  installSchema(db);
  ensurePinSecret(db);
  ensureConfigDefaults(db);
  initWordSchema(db);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_clients_bound_user ON clients(bound_user_id)",
  );
  ensureDefaultGroup(db);
  ensureAdminUser(db);
  createWordsService(db).ensureSampleWords();
}

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

  const runtimeInitialPin = runtimeConfig().initialAdminPin;
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
