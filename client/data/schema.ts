export const RUNTIME_DATABASE = "classapp-runtime";

// Version 5 removes every pre-Bundle domain/cache row while preserving the
// Shell's active application bundle across the hard data boundary.
export const RUNTIME_DATABASE_VERSION = 5;

export const GLOBAL_KEYS = {
  ACTIVE_ME: "active-me",
  ACTIVE_BUNDLE: "active-bundle",
} as const;

export const STORES = {
  FILES: "files",
  FILE_HEADS: "file_heads",
  GLOBALS: "globals",
  BUNDLES: "bundles",
  GROUPS: "domain_groups",
  DMS: "domain_dms",
  POSTS: "domain_posts",
  ARTICLES: "domain_articles",
  ARTICLE_SEGMENTS: "domain_article_segments",
  USERS: "domain_users",
  ME: "domain_me",
  ME_ACCESS: "domain_me_access",
  ME_CONV_STATE: "domain_me_conv_state",
  ME_ARTICLE_STATE: "domain_me_article_state",
  ME_STATE: "domain_me_state",
  SAVE: "domain_save",
  SYNC: "domain_sync",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

function createObjectiveStores(db: IDBDatabase): void {
  const groups = db.createObjectStore(STORES.GROUPS, { keyPath: "id" });
  groups.createIndex("by-conv", "conv_id", { unique: true });
  groups.createIndex("by-handle", "handle", { unique: true });

  const dms = db.createObjectStore(STORES.DMS, { keyPath: "conv_id" });
  dms.createIndex("by-peer-a", "peer_a");
  dms.createIndex("by-peer-b", "peer_b");

  const posts = db.createObjectStore(STORES.POSTS, { keyPath: "id" });
  posts.createIndex("by-conversation-sequence", ["conv_id", "sequence"], {
    unique: true,
  });
  posts.createIndex("by-conversation-revision", ["conv_id", "revision"]);
  posts.createIndex("by-eviction", ["eviction_tier", "touched_at"]);

  const articles = db.createObjectStore(STORES.ARTICLES, { keyPath: "id" });
  articles.createIndex("by-group-created", ["group_id", "created_at", "id"]);
  articles.createIndex("by-eviction", ["eviction_tier", "touched_at"]);

  const segments = db.createObjectStore(STORES.ARTICLE_SEGMENTS, {
    keyPath: ["article_id", "start_offset"],
  });
  segments.createIndex("by-article", "article_id");
  segments.createIndex("by-article-start", ["article_id", "start_offset"], {
    unique: true,
  });
  segments.createIndex("by-eviction", ["eviction_tier", "touched_at"]);

  const users = db.createObjectStore(STORES.USERS, { keyPath: "id" });
  users.createIndex("by-handle", "handle", { unique: true });
}

function createActorStores(db: IDBDatabase): void {
  db.createObjectStore(STORES.ME, { keyPath: "me_id" });

  const access = db.createObjectStore(STORES.ME_ACCESS, {
    keyPath: ["me_id", "kind", "object_id"],
  });
  access.createIndex("by-me-kind", ["me_id", "kind"]);
  access.createIndex("by-object", ["kind", "object_id"]);

  const conv = db.createObjectStore(STORES.ME_CONV_STATE, {
    keyPath: ["me_id", "conv_id"],
  });
  conv.createIndex("by-me", "me_id");
  conv.createIndex("by-pending", ["me_id", "pending"]);

  const article = db.createObjectStore(STORES.ME_ARTICLE_STATE, {
    keyPath: ["me_id", "article_id"],
  });
  article.createIndex("by-me", "me_id");
  article.createIndex("by-pending", ["me_id", "pending"]);

  const meState = db.createObjectStore(STORES.ME_STATE, {
    keyPath: ["me_id", "key"],
  });
  meState.createIndex("by-me", "me_id");
  meState.createIndex("by-pending", ["me_id", "pending"]);

  const save = db.createObjectStore(STORES.SAVE, {
    keyPath: ["claimant", "kind", "object_id"],
  });
  save.createIndex("by-resource", ["kind", "object_id"]);
  save.createIndex("by-expiry", ["kind", "protected_until"]);

  const sync = db.createObjectStore(STORES.SYNC, { keyPath: "scope" });
  sync.createIndex("by-kind", "kind");
}

/** Schema upgrades are hard domain-cache boundaries; no old domain row moves. */
export function upgradeRuntimeDatabase(
  request: IDBOpenDBRequest,
  oldVersion: number,
): void {
  const db = request.result;
  const runtimeStores = new Set<string>([STORES.GLOBALS, STORES.BUNDLES]);
  for (const name of Array.from(db.objectStoreNames)) {
    if (oldVersion < 4 || !runtimeStores.has(name)) {
      db.deleteObjectStore(name);
    }
  }

  db.createObjectStore(STORES.FILES);
  const heads = db.createObjectStore(STORES.FILE_HEADS, { keyPath: "id" });
  heads.createIndex("by-state-created", ["state", "created_at"]);

  if (!db.objectStoreNames.contains(STORES.GLOBALS)) {
    db.createObjectStore(STORES.GLOBALS, { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains(STORES.BUNDLES)) {
    db.createObjectStore(STORES.BUNDLES, { keyPath: "build_id" });
  }
  createObjectiveStores(db);
  createActorStores(db);
}
