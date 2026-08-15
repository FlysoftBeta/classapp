import {
  APP_SCHEMA_VERSION,
  createApplicationStores,
  GLOBAL_KEYS,
  RUNTIME_DATABASE,
  STORES,
} from "./schema";

const HISTORICAL_APPLICATION_STORES = [
  "files",
  "file_heads",
  "globals",
  "bundles",
  "groups",
  "dms",
  "posts",
  "articles",
  "article_segments",
  "users",
  "me",
  "me_access",
  "me_conv_state",
  "me_article_state",
  "me_state",
  "save",
  "sync",
  "domain_groups",
  "domain_dms",
  "domain_posts",
  "domain_articles",
  "domain_article_segments",
  "domain_users",
  "domain_me",
  "domain_me_access",
  "domain_me_conv_state",
  "domain_me_article_state",
  "domain_me_state",
  "domain_save",
  "domain_sync",
] as const;

type MigrationPlan =
  | { kind: "nuke-yanked" }
  | { kind: "add-me-gate-state" }
  | { kind: "drop-handle-indexes" };

interface OpenedDatabase {
  database: IDBDatabase;
  planApplied: boolean;
}

function openDatabase(
  version?: number,
  plan?: MigrationPlan,
): Promise<OpenedDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let planApplied = false;
    let blockedTimer: ReturnType<typeof setTimeout> | null = null;
    const request =
      version === undefined
        ? indexedDB.open(RUNTIME_DATABASE)
        : indexedDB.open(RUNTIME_DATABASE, version);
    request.onupgradeneeded = () => {
      if (!plan) return;
      planApplied = true;
      const db = request.result;
      const transaction = request.transaction!;
      const dropHandleIndexes = () => {
        for (const storeName of [STORES.GROUPS, STORES.USERS]) {
          const store = transaction.objectStore(storeName);
          if (store.indexNames.contains("by-handle")) {
            store.deleteIndex("by-handle");
          }
        }
      };
      const markLegacyUserMetadata = () => {
        const store = transaction.objectStore(STORES.USERS);
        const rows = store.getAll();
        rows.onsuccess = () => {
          for (const value of rows.result as Array<Record<string, unknown>>) {
            store.put({ ...value, revision: -1 });
          }
        };
      };
      const markLegacyMeUsers = () => {
        const store = transaction.objectStore(STORES.ME);
        const rows = store.getAll();
        rows.onsuccess = () => {
          for (const value of rows.result as Array<Record<string, unknown>>) {
            const user = value.user as Record<string, unknown> | undefined;
            if (user) {
              store.put({
                ...value,
                user: { ...user, profile_revision: -1 },
              });
            }
          }
        };
      };
      if (plan.kind === "add-me-gate-state") {
        dropHandleIndexes();
        markLegacyUserMetadata();
        const meStore = transaction.objectStore(STORES.ME);
        const rows = meStore.getAll();
        rows.onsuccess = () => {
          for (const value of rows.result as Array<Record<string, unknown>>) {
            const user = value.user as Record<string, unknown> | undefined;
            meStore.put({
              ...value,
              ...(user
                ? { user: { ...user, profile_revision: -1 } }
                : {}),
              konami_lock: {
                base: { value: false, updated_at: 0 },
                proposal: null,
              },
              app_disable: { disabled: false, reason: null },
              system_locked: false,
            });
          }
          transaction.objectStore(STORES.GLOBALS).put({
            key: GLOBAL_KEYS.APP_SCHEMA_VERSION,
            value: APP_SCHEMA_VERSION,
          });
        };
        return;
      }
      if (plan.kind === "drop-handle-indexes") {
        dropHandleIndexes();
        markLegacyUserMetadata();
        markLegacyMeUsers();
        transaction.objectStore(STORES.GLOBALS).put({
          key: GLOBAL_KEYS.APP_SCHEMA_VERSION,
          value: APP_SCHEMA_VERSION,
        });
        return;
      }
      // Keep the list explicit: a yanked schema must never leave an unknown
      // historical cache table carrying incompatible rows.
      for (const name of HISTORICAL_APPLICATION_STORES) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
      }
      createApplicationStores(db);
      transaction.objectStore(STORES.GLOBALS).put({
        key: GLOBAL_KEYS.APP_SCHEMA_VERSION,
        value: APP_SCHEMA_VERSION,
      });
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      if (blockedTimer) clearTimeout(blockedTimer);
      reject(request.error);
    };
    request.onblocked = () => {
      if (blockedTimer) return;
      blockedTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error("IndexedDB schema upgrade is blocked by another page"),
        );
      }, 5_000);
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      if (blockedTimer) clearTimeout(blockedTimer);
      resolve({ database: request.result, planApplied });
    };
  });
}

async function applicationSchemaVersion(
  db: IDBDatabase,
): Promise<number | null> {
  if (!db.objectStoreNames.contains(STORES.GLOBALS)) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORES.GLOBALS, "readonly");
    const request = tx
      .objectStore(STORES.GLOBALS)
      .get(GLOBAL_KEYS.APP_SCHEMA_VERSION);
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const value = (request.result as { value?: unknown } | undefined)?.value;
      resolve(typeof value === "number" ? value : null);
    };
  });
}

/**
 * Open at the physical head, then increment that head only when app schema
 * work is required. Physical IDB versions intentionally carry no semantics.
 */
export async function openApplicationDatabase(): Promise<IDBDatabase> {
  for (;;) {
    const { database: current } = await openDatabase();
    const schemaVersion = await applicationSchemaVersion(current);
    if (schemaVersion === APP_SCHEMA_VERSION) return current;

    const nextPhysicalVersion = current.version + 1;
    current.close();
    try {
      const { database: upgraded } = await openDatabase(
        nextPhysicalVersion,
        schemaVersion === 2
          ? { kind: "add-me-gate-state" }
          : schemaVersion === 3
            ? { kind: "drop-handle-indexes" }
            : { kind: "nuke-yanked" },
      );
      // Shell and app are independent schema owners. If the other owner won
      // this physical version race, our request opens successfully without a
      // versionchange; verify our marker before publishing the connection.
      if ((await applicationSchemaVersion(upgraded)) === APP_SCHEMA_VERSION) {
        return upgraded;
      }
      upgraded.close();
    } catch (error) {
      if (error instanceof DOMException && error.name === "VersionError") {
        continue;
      }
      throw error;
    }
  }
}

/** Unconditionally rebuild every application-owned store at a new IDB head. */
export async function nukeApplicationDatabase(): Promise<void> {
  for (;;) {
    const { database: current } = await openDatabase();
    const nextPhysicalVersion = current.version + 1;
    current.close();
    try {
      const { database: upgraded, planApplied } = await openDatabase(
        nextPhysicalVersion,
        { kind: "nuke-yanked" },
      );
      upgraded.close();
      if (planApplied) return;
      // Another schema owner won this physical version race without running
      // our plan. Advance again so an explicit reset can never become a no-op.
    } catch (error) {
      if (error instanceof DOMException && error.name === "VersionError") {
        continue;
      }
      throw error;
    }
  }
}
