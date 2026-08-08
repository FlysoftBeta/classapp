export const RUNTIME_DATABASE = "classapp-runtime";
export const RUNTIME_DATABASE_VERSION = 3;
export const ACTIVE_BUILD_KEY = "classapp-active-build";

export interface KeyValueRecord<T = unknown> {
  key: string;
  value: T;
}

export function upgradeRuntimeDatabase(request: IDBOpenDBRequest): void {
  const db = request.result;
  if (!db.objectStoreNames.contains("resources")) {
    const store = db.createObjectStore("resources", { keyPath: "key" });
    store.createIndex("by-class-and-touch", ["resourceClass", "touchedAt"]);
  }
  if (!db.objectStoreNames.contains("bundles")) {
    db.createObjectStore("bundles", { keyPath: "buildId" });
  }
  if (!db.objectStoreNames.contains("kv")) {
    db.createObjectStore("kv", { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains("domain_conversations")) {
    const store = db.createObjectStore("domain_conversations", {
      keyPath: ["userScope", "convId"],
    });
    store.createIndex("by-user", "userScope");
  }
  if (!db.objectStoreNames.contains("domain_posts")) {
    const store = db.createObjectStore("domain_posts", {
      keyPath: ["userScope", "id"],
    });
    store.createIndex("by-conversation", ["userScope", "convId"]);
    store.createIndex("by-conversation-sequence", [
      "userScope",
      "convId",
      "sequence",
    ]);
  }
  if (!db.objectStoreNames.contains("domain_articles")) {
    const store = db.createObjectStore("domain_articles", {
      keyPath: ["userScope", "id"],
    });
    store.createIndex("by-user", "userScope");
  }
  if (!db.objectStoreNames.contains("domain_article_state")) {
    const store = db.createObjectStore("domain_article_state", {
      keyPath: ["userScope", "articleId"],
    });
    store.createIndex("by-user", "userScope");
  }
  if (!db.objectStoreNames.contains("domain_article_segments")) {
    const store = db.createObjectStore("domain_article_segments", {
      keyPath: ["userScope", "articleId", "startOffset"],
    });
    store.createIndex("by-article", ["userScope", "articleId"]);
    store.createIndex("by-article-start", [
      "userScope",
      "articleId",
      "startOffset",
    ]);
  }
}

export function openRuntimeDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RUNTIME_DATABASE, RUNTIME_DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      if ((event as IDBVersionChangeEvent).oldVersion > 0) {
        for (const name of Array.from(request.result.objectStoreNames)) {
          request.result.deleteObjectStore(name);
        }
      }
      upgradeRuntimeDatabase(request);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

export function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

export function clearLegacyActiveBuild(): void {
  try {
    localStorage.removeItem(ACTIVE_BUILD_KEY);
  } catch {
    // IndexedDB is authoritative; inaccessible legacy storage is harmless.
  }
}
