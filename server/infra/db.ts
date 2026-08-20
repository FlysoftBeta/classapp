import { Database, default as BetterSQLite3 } from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import { rmSync } from "node:fs";
import { initWordSchema } from "@/server/data/words";
import { createWordsService } from "@/server/services/wordsService";
import { AccessService } from "@/server/services/accessService";
import { CapabilityService } from "@/server/services/capabilityService";
import { DATA_ROOT } from "./env";
import { runtimeConfig } from "@/server/infra/runtimeConfig";
import { DEFAULT_FEATURE_BITSET } from "@/server/data/featureBitset";
import { ADMIN_ROLES } from "@/shared/authority";

const DB_PATH = path.join(DATA_ROOT, "data.db");
const BUSY_TIMEOUT_MS = 5_000;

function configureConnection(db: Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

/** Coordinator thread: migrate, then keep this connection for protocol-adjacent SQL and Sticky short transactions. */
export function openCoordinatorDatabase(): Database {
  const db = new BetterSQLite3(DB_PATH);
  configureConnection(db);
  initializeDatabase(db);
  return db;
}

function ensureCapabilitySecret(db: Database) {
  const row = db
    .prepare("SELECT value FROM config WHERE key = 'capability_secret'")
    .get() as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "capability_secret",
      crypto.randomBytes(32).toString("hex"),
    );
  }
}

export function getCapabilitySecret(db: Database): string {
  ensureCapabilitySecret(db);
  return (
    db
      .prepare("SELECT value FROM config WHERE key = 'capability_secret'")
      .get() as { value: string }
  ).value;
}

/** Executor worker: the schema must already exist. Never share this handle across threads. */
export function openExecutorDatabase(): Database {
  const db = new BetterSQLite3(DB_PATH);
  configureConnection(db);
  return db;
}

const BASELINE_SCHEMA_VERSION = 17;
const CURRENT_SCHEMA_VERSION = 27;

interface SchemaMigration {
  /** Schema version after this migration commits. */
  readonly nextVersion: number;
  readonly run: (db: Database) => void;
}

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

const AI_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_conversations (
    id                          TEXT PRIMARY KEY,
    user_id                     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title                       TEXT NOT NULL,
    title_norm                  TEXT NOT NULL,
    active_leaf_message_id      TEXT,
    forked_from_conversation_id TEXT REFERENCES ai_conversations(id) ON DELETE SET NULL,
    forked_from_message_id      TEXT,
    last_assistant_sequence     INTEGER NOT NULL DEFAULT 0,
    last_read_assistant_sequence INTEGER NOT NULL DEFAULT 0,
    archived_at                 TEXT,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_updated
    ON ai_conversations(user_id, archived_at, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_conversations_title
    ON ai_conversations(user_id, title_norm);

  CREATE TABLE IF NOT EXISTS ai_messages (
    sequence          INTEGER PRIMARY KEY AUTOINCREMENT,
    id                TEXT NOT NULL UNIQUE,
    conversation_id   TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    parent_message_id TEXT REFERENCES ai_messages(id) ON DELETE RESTRICT,
    role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content           TEXT NOT NULL DEFAULT '',
    attachments_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attachments_json)),
    status            TEXT NOT NULL CHECK (
      status IN ('pending', 'streaming', 'completed', 'failed', 'cancelled')
    ),
    run_id            TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_sequence
    ON ai_messages(conversation_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_ai_messages_parent
    ON ai_messages(parent_message_id);

  CREATE TABLE IF NOT EXISTS ai_runs (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id   TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    input_message_id  TEXT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
    output_message_id TEXT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
    status            TEXT NOT NULL CHECK (
      status IN ('queued', 'routing', 'running', 'completed', 'failed', 'cancelled')
    ),
    revision          INTEGER NOT NULL DEFAULT 0,
    model_placeholder TEXT,
    provider_model    TEXT,
    reasoning_effort  TEXT,
    reserved_credit_micros INTEGER NOT NULL DEFAULT 0,
    charged_credit_micros  INTEGER NOT NULL DEFAULT 0,
    input_tokens      INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens     INTEGER NOT NULL DEFAULT 0,
    cancel_requested  INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    error             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_runs_one_active_conversation
    ON ai_runs(conversation_id)
    WHERE status IN ('queued', 'routing', 'running');
  CREATE INDEX IF NOT EXISTS idx_ai_runs_user_updated
    ON ai_runs(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS ai_run_attempts (
    id                  TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
    attempt             INTEGER NOT NULL,
    provider_model      TEXT NOT NULL,
    provider_request_id TEXT,
    status              TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    visible_output      INTEGER NOT NULL DEFAULT 0 CHECK (visible_output IN (0, 1)),
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    error               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (run_id, attempt)
  );

  CREATE TABLE IF NOT EXISTS ai_conversation_tags (
    conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    normalized_tag  TEXT NOT NULL,
    display_tag     TEXT NOT NULL,
    prompt_version  INTEGER NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (conversation_id, normalized_tag)
  );
  CREATE INDEX IF NOT EXISTS idx_ai_conversation_tags_lookup
    ON ai_conversation_tags(normalized_tag, conversation_id);

  CREATE TABLE IF NOT EXISTS ai_context_snapshots (
    id                 TEXT PRIMARY KEY,
    conversation_id    TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    through_message_id TEXT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
    summary_json       TEXT NOT NULL CHECK (json_valid(summary_json)),
    prompt_version     INTEGER NOT NULL,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (conversation_id, through_message_id, prompt_version)
  );

  CREATE TABLE IF NOT EXISTS ai_credit_accounts (
    user_id                TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    top_up_credit_micros   INTEGER NOT NULL DEFAULT 0 CHECK (top_up_credit_micros >= 0),
    reserved_credit_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_credit_micros >= 0),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ai_credit_ledger (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('top_up', 'reserve', 'settle', 'release')),
    delta_credit_micros        INTEGER NOT NULL,
    top_up_after_credit_micros INTEGER NOT NULL CHECK (top_up_after_credit_micros >= 0),
    run_id          TEXT REFERENCES ai_runs(id) ON DELETE SET NULL,
    admin_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    note            TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_credit_ledger_user_created
    ON ai_credit_ledger(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS ai_billing_policy (
    id                         INTEGER PRIMARY KEY CHECK (id = 1),
    daily_credit_micros        INTEGER NOT NULL CHECK (daily_credit_micros >= 0),
    weekly_credit_micros       INTEGER NOT NULL CHECK (weekly_credit_micros >= 0),
    default_plan_duration_days INTEGER NOT NULL CHECK (default_plan_duration_days > 0),
    updated_by                 TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO ai_billing_policy
    (id, daily_credit_micros, weekly_credit_micros, default_plan_duration_days)
    VALUES (1, 100000000, 300000000, 30);

  CREATE TABLE IF NOT EXISTS ai_plan_enrollments (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    starts_at  TEXT NOT NULL,
    ends_at    TEXT NOT NULL,
    assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (ends_at > starts_at)
  );

  CREATE TABLE IF NOT EXISTS ai_credit_reservations (
    operation_id TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    run_id       TEXT REFERENCES ai_runs(id) ON DELETE SET NULL,
    amount_credit_micros INTEGER NOT NULL CHECK (amount_credit_micros >= 0),
    status       TEXT NOT NULL CHECK (status IN ('active', 'settled', 'released')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_credit_reservations_user_status
    ON ai_credit_reservations(user_id, status);

  CREATE TABLE IF NOT EXISTS ai_credit_usage (
    id                  TEXT PRIMARY KEY,
    operation_id        TEXT NOT NULL UNIQUE,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    run_id              TEXT REFERENCES ai_runs(id) ON DELETE SET NULL,
    day_key             TEXT NOT NULL,
    week_key            TEXT NOT NULL,
    charged_credit_micros INTEGER NOT NULL CHECK (charged_credit_micros >= 0),
    plan_credit_micros    INTEGER NOT NULL CHECK (plan_credit_micros >= 0),
    top_up_credit_micros  INTEGER NOT NULL CHECK (top_up_credit_micros >= 0),
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (charged_credit_micros = plan_credit_micros + top_up_credit_micros)
  );
  CREATE INDEX IF NOT EXISTS idx_ai_credit_usage_user_day
    ON ai_credit_usage(user_id, day_key);
  CREATE INDEX IF NOT EXISTS idx_ai_credit_usage_week
    ON ai_credit_usage(week_key);

  CREATE TABLE IF NOT EXISTS ai_file_operations (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    run_id          TEXT REFERENCES ai_runs(id) ON DELETE SET NULL,
    call_id         TEXT NOT NULL,
    before_revision INTEGER NOT NULL,
    after_revision  INTEGER NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('planned', 'committed', 'failed')),
    result_json     TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    error           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, call_id)
  );

  CREATE TABLE IF NOT EXISTS ai_workspaces (
    user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    blob_id          TEXT,
    staging_blob_id  TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const MEDIA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS media_tracks (
    id                 TEXT PRIMARY KEY,
    source             TEXT NOT NULL,
    provider_id        TEXT NOT NULL,
    canonical_url      TEXT NOT NULL,
    title              TEXT NOT NULL,
    artists_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artists_json)),
    album              TEXT,
    duration_ms        INTEGER NOT NULL CHECK (duration_ms >= 0),
    thumbnail_url      TEXT,
    metadata_revision  INTEGER NOT NULL DEFAULT 0,
    ref_count          INTEGER NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
    last_used_at       TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (source, provider_id)
  );
  CREATE INDEX IF NOT EXISTS idx_media_tracks_last_used
    ON media_tracks(ref_count, last_used_at);

  CREATE TABLE IF NOT EXISTS media_assets (
    track_id      TEXT NOT NULL REFERENCES media_tracks(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('audio', 'cover')),
    state         TEXT NOT NULL CHECK (state IN ('queued', 'downloading', 'ready', 'failed')),
    blob_id       TEXT UNIQUE,
    mime          TEXT,
    bytes         INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    sha256        TEXT,
    failed_code   TEXT,
    downloaded_at TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (track_id, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_media_assets_ready
    ON media_assets(kind, state, downloaded_at);

  CREATE TABLE IF NOT EXISTS media_lists (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL CHECK (kind IN ('playlist', 'queue', 'booklist')),
    title          TEXT NOT NULL,
    revision       INTEGER NOT NULL DEFAULT 0,
    retention_days INTEGER NOT NULL DEFAULT 7 CHECK (retention_days BETWEEN 1 AND 365),
    expires_at     TEXT,
    origin_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_owned_lists_group_booklist
    ON media_lists(origin_group_id)
    WHERE kind = 'booklist' AND origin_group_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_owned_lists_kind_updated
    ON media_lists(kind, updated_at DESC);

  CREATE TABLE IF NOT EXISTS media_list_items (
    list_id   TEXT NOT NULL REFERENCES media_lists(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL CHECK (position >= 0),
    track_id  TEXT NOT NULL REFERENCES media_tracks(id) ON DELETE CASCADE,
    added_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (list_id, position)
  );
  CREATE INDEX IF NOT EXISTS idx_media_list_items_track
    ON media_list_items(track_id, list_id);

  CREATE TABLE IF NOT EXISTS media_stream_grants (
    token      TEXT PRIMARY KEY,
    track_id   TEXT NOT NULL REFERENCES media_tracks(id) ON DELETE CASCADE,
    user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_media_stream_grants_track
    ON media_stream_grants(track_id, expires_at);

  CREATE TRIGGER IF NOT EXISTS media_items_ref_count_insert
  AFTER INSERT ON media_list_items BEGIN
    UPDATE media_tracks
       SET ref_count = ref_count + 1,
           last_used_at = datetime('now')
     WHERE id = NEW.track_id;
  END;

  CREATE TRIGGER IF NOT EXISTS media_items_ref_count_delete
  AFTER DELETE ON media_list_items BEGIN
    UPDATE media_tracks
       SET ref_count = ref_count - 1
     WHERE id = OLD.track_id AND ref_count > 0;
    SELECT CASE WHEN changes() = 0
      THEN RAISE(ABORT, 'media_tracks.ref_count underflow') END;
  END;
`;

const STORAGE_QUOTA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS storage_quota_pools (
    name          TEXT PRIMARY KEY,
    max_weight    INTEGER NOT NULL DEFAULT 0 CHECK (max_weight >= 0),
    target_ratio  REAL NOT NULL DEFAULT 0.8 CHECK (target_ratio > 0 AND target_ratio <= 1),
    half_life_ms  INTEGER NOT NULL CHECK (half_life_ms > 0),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS storage_quota_items (
    pool           TEXT NOT NULL REFERENCES storage_quota_pools(name) ON DELETE CASCADE,
    item_id        TEXT NOT NULL,
    class          TEXT NOT NULL CHECK (class IN ('cache', 'durable')),
    weight         INTEGER NOT NULL DEFAULT 0 CHECK (weight >= 0),
    heat           REAL NOT NULL DEFAULT 0 CHECK (heat >= 0),
    touched_at_ms  INTEGER NOT NULL,
    pin_until_ms   INTEGER NOT NULL DEFAULT 0 CHECK (pin_until_ms >= 0),
    created_at_ms  INTEGER NOT NULL,
    PRIMARY KEY (pool, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_storage_quota_items_pool_class
    ON storage_quota_items(pool, class, weight);
`;

const ARTICLE_UPLOADS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS article_uploads (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    booklist_id  TEXT NOT NULL REFERENCES media_lists(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('staging', 'published', 'abandoned')),
    source_blob_id   TEXT NOT NULL,
    archive_blob_id  TEXT NOT NULL,
    source_bytes INTEGER NOT NULL DEFAULT 0 CHECK (source_bytes >= 0),
    archive_bytes INTEGER NOT NULL DEFAULT 0 CHECK (archive_bytes >= 0),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_article_uploads_status_created
    ON article_uploads(status, created_at);
`;

const ACCESS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS access_bindings (
    resource_kind  TEXT NOT NULL CHECK (resource_kind IN ('playlist', 'booklist', 'queue')),
    resource_id    TEXT NOT NULL,
    principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user', 'group')),
    principal_id   TEXT NOT NULL,
    grants_json    TEXT NOT NULL CHECK (json_valid(grants_json)),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (resource_kind, resource_id, principal_kind, principal_id)
  );
  CREATE INDEX IF NOT EXISTS idx_access_bindings_principal
    ON access_bindings(principal_kind, principal_id, resource_kind);
  CREATE INDEX IF NOT EXISTS idx_access_bindings_resource
    ON access_bindings(resource_kind, resource_id);

  CREATE TABLE IF NOT EXISTS access_effective (
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource_kind    TEXT NOT NULL CHECK (resource_kind IN ('playlist', 'booklist', 'queue')),
    resource_id      TEXT NOT NULL,
    can_read         INTEGER NOT NULL CHECK (can_read IN (0, 1)),
    can_write        INTEGER NOT NULL CHECK (can_write IN (0, 1)),
    can_own          INTEGER NOT NULL CHECK (can_own IN (0, 1)),
    can_share_read   INTEGER NOT NULL CHECK (can_share_read IN (0, 1)),
    can_share_write  INTEGER NOT NULL CHECK (can_share_write IN (0, 1)),
    can_share_own    INTEGER NOT NULL CHECK (can_share_own IN (0, 1)),
    provenance_json  TEXT NOT NULL CHECK (json_valid(provenance_json)),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, resource_kind, resource_id)
  );
  CREATE INDEX IF NOT EXISTS idx_access_effective_user_kind
    ON access_effective(user_id, resource_kind, can_read);
  CREATE INDEX IF NOT EXISTS idx_access_effective_resource
    ON access_effective(resource_kind, resource_id);

  CREATE TABLE IF NOT EXISTS resource_possession (
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource_kind  TEXT NOT NULL CHECK (resource_kind IN ('track', 'article')),
    resource_id    TEXT NOT NULL,
    capability     TEXT NOT NULL,
    source_kind    TEXT NOT NULL,
    source_id      TEXT,
    expires_at_ms  INTEGER NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, resource_kind, resource_id)
  );
  CREATE INDEX IF NOT EXISTS idx_resource_possession_expiry
    ON resource_possession(expires_at_ms);

  CREATE TABLE IF NOT EXISTS user_favorites (
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource_kind  TEXT NOT NULL CHECK (resource_kind IN ('track', 'article', 'playlist', 'booklist')),
    resource_id    TEXT NOT NULL,
    favorited      INTEGER NOT NULL DEFAULT 1 CHECK (favorited IN (0, 1)),
    updated_at_ms  INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, resource_kind, resource_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_favorites_user
    ON user_favorites(user_id, resource_kind, favorited, updated_at_ms DESC);

  CREATE TABLE IF NOT EXISTS user_recents (
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource_kind    TEXT NOT NULL CHECK (resource_kind IN ('track', 'article', 'playlist', 'booklist')),
    resource_id      TEXT NOT NULL,
    last_used_at     TEXT NOT NULL,
    last_used_at_ms  INTEGER NOT NULL,
    PRIMARY KEY (user_id, resource_kind, resource_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_recents_user
    ON user_recents(user_id, resource_kind, last_used_at_ms DESC);

  CREATE TABLE IF NOT EXISTS user_queues (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    list_id TEXT NOT NULL UNIQUE REFERENCES media_lists(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS booklist_items (
    list_id     TEXT NOT NULL REFERENCES media_lists(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL CHECK (position >= 0),
    article_id  TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    added_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (list_id, position)
  );
  CREATE INDEX IF NOT EXISTS idx_booklist_items_article
    ON booklist_items(article_id, list_id);
`;

/** v17 → v18: original incident/AI introduction and legacy feature bit. */
function migrateV17ToV18(db: Database): void {
  db.exec(INCIDENT_SCHEMA);
  db.exec(AI_SCHEMA);
  // Schema v18 still used the legacy bit layout where bit 0 was admin.
  db.prepare("UPDATE users SET feature_mask = feature_mask | ?").run(1 << 7);
}

/**
 * Production databases are schema v18. Everything after v18 is consolidated
 * into one ordered migration: v18 → v25. Intermediate versions are not
 * supported and the ledger can jump several versions in one transaction.
 * Schema v26 then replaces the object/quota model and drops reconstructible cache.
 */
function consolidatePostV18Schema(db: Database): void {
  // v19: roles moved out of the feature bitset into user_admin_roles.
  db.exec(`
    ALTER TABLE users RENAME COLUMN feature_mask TO feature_bitset;
    CREATE TABLE user_admin_roles (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN (${ADMIN_ROLES.map((role) => `'${role}'`).join(", ")})),
      granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, role)
    );
    CREATE INDEX idx_user_admin_roles_role
      ON user_admin_roles(role, user_id);
  `);
  const oldAdmins = db
    .prepare(
      "SELECT id FROM users WHERE (feature_bitset & 1) != 0 ORDER BY created_at, id",
    )
    .all() as Array<{ id: string }>;
  const insert = db.prepare(
    `INSERT INTO user_admin_roles (user_id, role, granted_by)
     VALUES (?, ?, NULL)`,
  );
  for (const admin of oldAdmins) {
    for (const role of ADMIN_ROLES) {
      if (role !== "root") insert.run(admin.id, role);
    }
  }
  if (oldAdmins[0]) insert.run(oldAdmins[0].id, "root");
  db.exec(`
    UPDATE users SET feature_bitset = feature_bitset >> 1;
    ALTER TABLE users DROP COLUMN role;
  `);

  // v20: AI credit columns changed unit and naming from whole credits to micros.
  const aiColumns = db.prepare("PRAGMA table_info(ai_runs)").all() as Array<{
    name: string;
  }>;
  if (aiColumns.some((column) => column.name === "reserved_credits")) {
    db.exec(`
      ALTER TABLE ai_runs RENAME COLUMN reserved_credits TO reserved_credit_micros;
      ALTER TABLE ai_runs RENAME COLUMN charged_credits TO charged_credit_micros;
      ALTER TABLE ai_credit_accounts RENAME COLUMN balance TO top_up_credit_micros;
      ALTER TABLE ai_credit_accounts RENAME COLUMN reserved TO reserved_credit_micros;
      ALTER TABLE ai_credit_ledger RENAME COLUMN delta TO delta_credit_micros;
      ALTER TABLE ai_credit_ledger RENAME COLUMN balance_after TO top_up_after_credit_micros;
      UPDATE ai_runs SET
        reserved_credit_micros = reserved_credit_micros * 1000000,
        charged_credit_micros = charged_credit_micros * 1000000;
      UPDATE ai_credit_accounts SET
        top_up_credit_micros = top_up_credit_micros * 1000000,
        reserved_credit_micros = reserved_credit_micros * 1000000;
      UPDATE ai_credit_ledger SET
        delta_credit_micros = delta_credit_micros * 1000000,
        top_up_after_credit_micros = top_up_after_credit_micros * 1000000;
    `);
  }
  db.exec(AI_SCHEMA);

  // v21: user profile revision.
  db.exec(
    "ALTER TABLE users ADD COLUMN profile_revision INTEGER NOT NULL DEFAULT 0",
  );

  // v22: media catalog; enabled by default for existing accounts.
  db.exec(MEDIA_SCHEMA);
  db.prepare("UPDATE users SET feature_bitset = feature_bitset | ?").run(
    1 << 7,
  );

  // v23: shared object storage and quota; teach_documents object references.
  db.exec(STORAGE_QUOTA_SCHEMA);
  db.exec("ALTER TABLE teach_documents RENAME COLUMN blob_path TO object_key");
  db.exec(
    "ALTER TABLE teach_documents ADD COLUMN status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('capturing', 'ready'))",
  );

  // v24: durable multipart article-upload intents.
  db.exec(ARTICLE_UPLOADS_SCHEMA);
  const teachColumns = db
    .prepare("PRAGMA table_info(teach_documents)")
    .all() as Array<{ name: string }>;
  if (!teachColumns.some((column) => column.name === "status")) {
    db.exec(
      "ALTER TABLE teach_documents ADD COLUMN status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('capturing', 'ready'))",
    );
  }

  // Blob-owned WIP rows are not migrated. Text articles are pure SQL and are
  // preserved; their bookmarks/segments/progress cascade normally.
  db.prepare("DELETE FROM article_uploads").run();
  db.prepare(
    `DELETE FROM articles
      WHERE json_extract(provider_json, '$.type') = 'bundle'`,
  ).run();
  db.prepare("DELETE FROM teach_documents").run();
}

function tableColumns(db: Database, table: string): Set<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((column) => column.name),
  );
}

function renameColumnIfPresent(
  db: Database,
  table: string,
  from: string,
  to: string,
): void {
  const columns = tableColumns(db, table);
  if (columns.has(from) && !columns.has(to)) {
    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  }
}

/**
 * v25 → v26: allocated blob ids and heat quota. Reconstructible cache from the
 * previous object store is dropped; metadata such as media tracks is kept.
 */
function migrateV25ToV26(db: Database): void {
  db.exec("DROP TABLE IF EXISTS storage_quota_items");
  db.exec("DROP TABLE IF EXISTS storage_eviction_groups");
  db.exec("DROP TABLE IF EXISTS storage_quota_pools");
  db.exec(STORAGE_QUOTA_SCHEMA);

  renameColumnIfPresent(db, "media_assets", "object_path", "blob_id");
  db.prepare("DELETE FROM media_assets").run();

  renameColumnIfPresent(db, "teach_documents", "object_key", "blob_id");
  db.prepare("DELETE FROM teach_documents").run();

  renameColumnIfPresent(db, "article_uploads", "source_key", "source_blob_id");
  renameColumnIfPresent(db, "article_uploads", "archive_key", "archive_blob_id");
  db.prepare("DELETE FROM article_uploads").run();
  db.prepare(
    `DELETE FROM articles
      WHERE json_extract(provider_json, '$.type') = 'bundle'`,
  ).run();

  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_workspaces (
      user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      blob_id          TEXT,
      staging_blob_id  TEXT,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("DELETE FROM ai_workspaces").run();

  rmSync(path.join(DATA_ROOT, "storage"), { recursive: true, force: true });
}

/**
 * v26 → v27: ownerless articles/tracks use signed capabilities; playlists and
 * booklists use principal×resource access bindings. Existing group-chat
 * articles remain objective resources collected into a group-owned booklist.
 */
function migrateV26ToV27(db: Database): void {
  ensureCapabilitySecret(db);

  const previousLists = db
    .prepare(
      `SELECT id, kind, owner_user_id FROM media_lists`,
    )
    .all() as Array<{ id: string; kind: "playlist" | "queue"; owner_user_id: string }>;

  db.exec(`
    CREATE TABLE media_lists_v27 (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL CHECK (kind IN ('playlist', 'queue', 'booklist')),
      title           TEXT NOT NULL,
      revision        INTEGER NOT NULL DEFAULT 0,
      retention_days  INTEGER NOT NULL DEFAULT 7 CHECK (retention_days BETWEEN 1 AND 365),
      expires_at      TEXT,
      origin_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE media_list_items_v27 (
      list_id   TEXT NOT NULL REFERENCES media_lists_v27(id) ON DELETE CASCADE,
      position  INTEGER NOT NULL CHECK (position >= 0),
      track_id  TEXT NOT NULL REFERENCES media_tracks(id) ON DELETE CASCADE,
      added_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (list_id, position)
    );
    INSERT INTO media_lists_v27
      (id, kind, title, revision, retention_days, expires_at, created_at, updated_at)
    SELECT id, kind, title, revision, retention_days, expires_at, created_at, updated_at
      FROM media_lists;
    INSERT INTO media_list_items_v27 (list_id, position, track_id, added_at)
    SELECT list_id, position, track_id, added_at FROM media_list_items;
  `);
  db.exec("DROP TRIGGER IF EXISTS media_items_ref_count_insert");
  db.exec("DROP TRIGGER IF EXISTS media_items_ref_count_delete");
  db.exec("DROP TABLE media_list_items");
  db.exec("DROP TABLE media_lists");
  db.exec("ALTER TABLE media_lists_v27 RENAME TO media_lists");
  db.exec("ALTER TABLE media_list_items_v27 RENAME TO media_list_items");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_media_list_items_track
      ON media_list_items(track_id, list_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_owned_lists_group_booklist
      ON media_lists(origin_group_id)
      WHERE kind = 'booklist' AND origin_group_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_owned_lists_kind_updated
      ON media_lists(kind, updated_at DESC);
    CREATE TRIGGER IF NOT EXISTS media_items_ref_count_insert
    AFTER INSERT ON media_list_items BEGIN
      UPDATE media_tracks
         SET ref_count = ref_count + 1,
             last_used_at = datetime('now')
       WHERE id = NEW.track_id;
    END;
    CREATE TRIGGER IF NOT EXISTS media_items_ref_count_delete
    AFTER DELETE ON media_list_items BEGIN
      UPDATE media_tracks
         SET ref_count = ref_count - 1
       WHERE id = OLD.track_id AND ref_count > 0;
      SELECT CASE WHEN changes() = 0
        THEN RAISE(ABORT, 'media_tracks.ref_count underflow') END;
    END;
  `);

  db.exec(ACCESS_SCHEMA);
  db.exec("DROP TABLE IF EXISTS booklist_items");

  const bindOwner = db.prepare(
    `INSERT INTO access_bindings (
       resource_kind, resource_id, principal_kind, principal_id, grants_json
     ) VALUES (?, ?, 'user', ?, ?)`,
  );
  const bindQueue = db.prepare(
    "INSERT INTO user_queues (user_id, list_id) VALUES (?, ?)",
  );
  const ownerGrant = JSON.stringify([{ mode: "owner" }]);
  for (const list of previousLists) {
    bindOwner.run(list.kind, list.id, list.owner_user_id, ownerGrant);
    if (list.kind === "queue") bindQueue.run(list.owner_user_id, list.id);
  }

  db.exec(`
    CREATE TABLE articles_v27 (
      id              TEXT PRIMARY KEY,
      user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
      origin_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
      title           TEXT NOT NULL,
      provider_json   TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO articles_v27 (id, user_id, origin_group_id, title, provider_json, created_at)
    SELECT id, user_id, group_id, title, provider_json, created_at FROM articles;
    CREATE TABLE text_article_segments_v27 (
      article_id    TEXT NOT NULL REFERENCES articles_v27(id) ON DELETE CASCADE,
      segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
      start_offset  INTEGER NOT NULL CHECK (start_offset >= 0),
      char_count    INTEGER NOT NULL CHECK (char_count BETWEEN 1 AND 10000),
      content       TEXT NOT NULL,
      PRIMARY KEY (article_id, segment_index),
      UNIQUE (article_id, start_offset)
    );
    INSERT INTO text_article_segments_v27
    SELECT article_id, segment_index, start_offset, char_count, content
      FROM text_article_segments;
    CREATE TABLE article_bookmarks_v27 (
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      article_id    TEXT NOT NULL REFERENCES articles_v27(id) ON DELETE CASCADE,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      bookmarked    INTEGER NOT NULL DEFAULT 1,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, article_id)
    );
    INSERT INTO article_bookmarks_v27
    SELECT user_id, article_id, created_at, bookmarked, updated_at_ms FROM article_bookmarks;
    CREATE TABLE article_read_progress_v27 (
      user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      article_id         TEXT NOT NULL REFERENCES articles_v27(id) ON DELETE CASCADE,
      offset             INTEGER NOT NULL DEFAULT 0,
      locator            TEXT,
      total_read_seconds INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at_ms      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, article_id)
    );
    INSERT INTO article_read_progress_v27
    SELECT user_id, article_id, offset, locator, total_read_seconds, updated_at, updated_at_ms
      FROM article_read_progress;
  `);
  db.exec("DROP TRIGGER IF EXISTS articles_immutable");
  db.exec("DROP TRIGGER IF EXISTS text_article_segments_immutable");
  db.exec("DROP TABLE text_article_segments");
  db.exec("DROP TABLE article_bookmarks");
  db.exec("DROP TABLE article_read_progress");
  db.exec("DROP TABLE articles");
  db.exec("ALTER TABLE articles_v27 RENAME TO articles");
  db.exec("ALTER TABLE text_article_segments_v27 RENAME TO text_article_segments");
  db.exec("ALTER TABLE article_bookmarks_v27 RENAME TO article_bookmarks");
  db.exec("ALTER TABLE article_read_progress_v27 RENAME TO article_read_progress");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_articles_user ON articles(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_origin_group ON articles(origin_group_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_created_id ON articles(created_at DESC, id DESC);
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
    CREATE TABLE IF NOT EXISTS booklist_items (
      list_id     TEXT NOT NULL REFERENCES media_lists(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL CHECK (position >= 0),
      article_id  TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      added_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (list_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_booklist_items_article
      ON booklist_items(article_id, list_id);
  `);

  const groupsWithArticles = db
    .prepare(
      `SELECT DISTINCT origin_group_id AS group_id FROM articles
        WHERE origin_group_id IS NOT NULL`,
    )
    .all() as Array<{ group_id: string }>;
  const insertList = db.prepare(
    `INSERT INTO media_lists (id, kind, title, origin_group_id)
     VALUES (?, 'booklist', ?, ?)`,
  );
  const insertBookItem = db.prepare(
    `INSERT INTO booklist_items (list_id, position, article_id)
     VALUES (?, ?, ?)`,
  );
  const bindGroup = db.prepare(
    `INSERT INTO access_bindings (
       resource_kind, resource_id, principal_kind, principal_id, grants_json
     ) VALUES ('booklist', ?, 'group', ?, ?)`,
  );
  for (const row of groupsWithArticles) {
    const group = db
      .prepare("SELECT id, name FROM groups WHERE id = ?")
      .get(row.group_id) as { id: string; name: string } | undefined;
    if (!group) continue;
    const listId = crypto.randomUUID();
    insertList.run(listId, `${group.name}的文单`, group.id);
    bindGroup.run(listId, group.id, ownerGrant);
    const articles = db
      .prepare(
        `SELECT id FROM articles WHERE origin_group_id = ? ORDER BY created_at, id`,
      )
      .all(group.id) as Array<{ id: string }>;
    articles.forEach((article, index) => {
      insertBookItem.run(listId, index, article.id);
    });
  }

  db.exec(`
    INSERT OR IGNORE INTO user_favorites
      (user_id, resource_kind, resource_id, favorited, updated_at_ms, created_at)
    SELECT user_id, 'article', article_id, bookmarked, updated_at_ms, created_at
      FROM article_bookmarks;
    INSERT OR IGNORE INTO user_recents
      (user_id, resource_kind, resource_id, last_used_at, last_used_at_ms)
    SELECT user_id, 'article', article_id, updated_at, updated_at_ms
      FROM article_read_progress
     WHERE total_read_seconds >= 30;
    DROP TABLE article_bookmarks;
  `);

  db.exec("DROP TABLE IF EXISTS article_uploads");
  db.exec(ARTICLE_UPLOADS_SCHEMA);

  const access = new AccessService(
    db,
    new CapabilityService(getCapabilitySecret(db)),
  );
  const resources = db
    .prepare(
      `SELECT DISTINCT resource_kind, resource_id FROM access_bindings`,
    )
    .all() as Array<{
    resource_kind: "playlist" | "booklist" | "queue";
    resource_id: string;
  }>;
  for (const resource of resources) {
    access.rematerializeResource(resource.resource_kind, resource.resource_id);
  }
}

const MIGRATIONS = new Map<number, SchemaMigration>([
  [17, { nextVersion: 18, run: migrateV17ToV18 }],
  [18, { nextVersion: 25, run: consolidatePostV18Schema }],
  [25, { nextVersion: 26, run: migrateV25ToV26 }],
  [26, { nextVersion: CURRENT_SCHEMA_VERSION, run: migrateV26ToV27 }],
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
      throw new Error(`缺少 Schema v${version} 的迁移`);
    }
    if (
      migration.nextVersion <= version ||
      migration.nextVersion > CURRENT_SCHEMA_VERSION
    ) {
      throw new Error(`Schema v${version} 的迁移目标版本无效`);
    }
    db.transaction(() => {
      migration.run(db);
      db.prepare(
        "UPDATE config SET value = ? WHERE key = 'schema_version'",
      ).run(String(migration.nextVersion));
    })();
    version = migration.nextVersion;
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
      profile_revision INTEGER NOT NULL DEFAULT 0,
      feature_bitset INTEGER NOT NULL DEFAULT ${DEFAULT_FEATURE_BITSET},
      is_muted     INTEGER NOT NULL DEFAULT 0,
      muted_until  TEXT,
      banned_until TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_admin_roles (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN (${ADMIN_ROLES.map((role) => `'${role}'`).join(", ")})),
      granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, role)
    );
    CREATE INDEX IF NOT EXISTS idx_user_admin_roles_role
      ON user_admin_roles(role, user_id);

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id           TEXT PRIMARY KEY,
      actor_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
      action       TEXT NOT NULL,
      target_kind  TEXT NOT NULL,
      target_id    TEXT,
      details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created
      ON admin_audit_log(created_at DESC, id DESC);

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
      origin_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
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
    CREATE INDEX IF NOT EXISTS idx_articles_origin_group ON articles(origin_group_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_created_id
      ON articles(created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS teach_documents (
      id            TEXT PRIMARY KEY,
      application   TEXT NOT NULL,
      document_type TEXT NOT NULL CHECK (document_type IN ('word', 'powerpoint', 'excel')),
      name          TEXT NOT NULL,
      blob_id       TEXT NOT NULL UNIQUE,
      file_size     INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('capturing', 'ready')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_teach_documents_created
      ON teach_documents(created_at DESC);

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
  db.exec(AI_SCHEMA);
  db.exec(MEDIA_SCHEMA);
  db.exec(STORAGE_QUOTA_SCHEMA);
  db.exec(ARTICLE_UPLOADS_SCHEMA);
  db.exec(ACCESS_SCHEMA);
  // Worktree/dev databases created while schema v23 was being developed may
  // already have media_lists without retention_days. Production upgrades from
  // v22 always create the complete table above, so this is a narrow repair.
  const mediaListColumns = db
    .prepare("PRAGMA table_info(media_lists)")
    .all() as Array<{ name: string }>;
  if (!mediaListColumns.some((column) => column.name === "retention_days")) {
    db.exec(
      "ALTER TABLE media_lists ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 7 CHECK (retention_days BETWEEN 1 AND 365)",
    );
  }

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
    CREATE INDEX IF NOT EXISTS idx_articles_origin_group ON articles(origin_group_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_created_id
      ON articles(created_at DESC, id DESC);
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
  ensureCapabilitySecret(db);
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
    INSERT OR IGNORE INTO config (key, value) VALUES ('media_max_volume', '1');
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
    .prepare(
      "SELECT user_id AS id FROM user_admin_roles WHERE role = 'root' LIMIT 1",
    )
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
      "INSERT INTO users (id, handle, username, feature_bitset) VALUES (?, 'admin', '管理员', ?)",
    ).run(id, DEFAULT_FEATURE_BITSET);
    const grant = db.prepare(
      "INSERT INTO user_admin_roles (user_id, role, granted_by) VALUES (?, ?, NULL)",
    );
    for (const role of ADMIN_ROLES) grant.run(id, role);
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
