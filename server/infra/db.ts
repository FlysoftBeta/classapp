import { Database, default as BetterSQLite3 } from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import { initUpdateManager, isUpdateManagerEnabled } from "./updateManager";
import { initWordSchema } from "@/server/data/words";
import { createWordsService } from "@/server/services/wordsService";
import { DATA_ROOT } from "./env";
import { getRuntimeConfig } from "@/server/infra/runtimeConfig";
import { ADMIN_FEATURE_MASK } from "@/shared/features";

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
      handle          TEXT UNIQUE,
      name            TEXT NOT NULL,
      discoverable    INTEGER NOT NULL DEFAULT 0,
      password_hash   TEXT,
      type            TEXT NOT NULL DEFAULT 'normal',
      members_hidden  INTEGER NOT NULL DEFAULT 0,
      admin_only      INTEGER NOT NULL DEFAULT 0,
      no_leave        INTEGER NOT NULL DEFAULT 0,
      parent_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_groups_handle ON groups(handle);

    CREATE TABLE IF NOT EXISTS user_groups (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
      hide_self  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      id           TEXT PRIMARY KEY,
      user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
      content      TEXT NOT NULL,
      brief        TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL DEFAULT '{"type":"text","text_same_as_brief":true}',
      group_id     TEXT REFERENCES groups(id) ON DELETE CASCADE,
      dm_to        TEXT REFERENCES users(id) ON DELETE CASCADE,
      reply_to     TEXT REFERENCES posts(id) ON DELETE SET NULL,
      is_deleted   INTEGER NOT NULL DEFAULT 0,
      deleted_at   TEXT,
      edited_at    TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_config (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_posts_group ON posts(group_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_dm    ON posts(user_id, dm_to, created_at DESC);

    CREATE TABLE IF NOT EXISTS ghost_users (
      id           TEXT PRIMARY KEY,
      pin_hash     TEXT NOT NULL UNIQUE,
      oobe_token   TEXT UNIQUE,
      oobe_expires TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS articles (
      id         TEXT PRIMARY KEY,
      user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      content_kind TEXT NOT NULL DEFAULT 'text',
      blob_path TEXT,
      mime_type TEXT,
      file_size INTEGER NOT NULL DEFAULT 0,
      original_filename TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_articles_user ON articles(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_group ON articles(group_id, created_at DESC);

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

    CREATE TABLE IF NOT EXISTS conversation_user_state (
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_type TEXT NOT NULL CHECK (conversation_type IN ('group', 'dm')),
      conversation_id   TEXT NOT NULL,
      last_read_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
      pinned_at         TEXT,
      pinned_updated_at_ms INTEGER NOT NULL DEFAULT 0,
      compose_draft     TEXT,
      compose_draft_updated_at INTEGER NOT NULL DEFAULT 0,
      muted             INTEGER NOT NULL DEFAULT 0,
      read_updated_at_ms INTEGER NOT NULL DEFAULT 0,
      muted_updated_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, conversation_type, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_user_state_read_post ON conversation_user_state(last_read_post_id);
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
const CURRENT_SCHEMA_VERSION = 15;

export function runMigrations(db: Database) {
  const row = db
    .prepare("SELECT value FROM config WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  if (!row) {
    finalizeSchemaV15(db);
    setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
    return;
  }

  const version = Number.parseInt(row.value, 10);
  if (version === CURRENT_SCHEMA_VERSION) {
    finalizeSchemaV15(db);
    return;
  }
  if (version !== PROD_SCHEMA_VERSION)
    throw new Error(
      `不支持从 Schema v${row.value} 迁移；仅支持生产基线 v${PROD_SCHEMA_VERSION}`,
    );
  migrateProdV14ToV15(db);
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
    setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
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

function finalizeSchemaV15(db: Database): void {
  db.transaction(() => {
    applyClientManagementV15(db);
    applyArticleCenterV15(db);
    applyTeachDocumentsV15(db);
  })();
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
      `INSERT INTO groups (id, handle, name, discoverable, type, no_leave)
       VALUES ('wild', 'wild', '大别野', 0, 'wild', 1)`,
    ).run();
  }
  if (
    !db
      .prepare("SELECT 1 FROM groups WHERE type = 'announcement' LIMIT 1")
      .get()
  ) {
    db.prepare(
      `INSERT INTO groups (id, handle, name, discoverable, type, members_hidden, admin_only, no_leave)
       VALUES ('announcement', 'announcement', '公告', 0, 'announcement', 1, 1, 1)`,
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
    `INSERT OR IGNORE INTO user_groups (user_id, group_id)
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
      `INSERT OR IGNORE INTO user_groups (user_id, group_id)
       SELECT ?, id FROM groups WHERE type IN ('wild', 'announcement')`,
    ).run(id);
  })();

  console.log("\n============================================");
  console.log("  首次启动 — 管理员 PIN 码：" + pin);
  console.log("  请妥善保管，此信息不会再次显示");
  console.log("============================================\n");
}
