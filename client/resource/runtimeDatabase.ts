export const RUNTIME_DATABASE = "classapp-runtime";
export const RUNTIME_DATABASE_VERSION = 2;
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
    const kv = db.createObjectStore("kv", { keyPath: "key" });
    const legacyActiveBuild = readLegacyActiveBuild();
    if (legacyActiveBuild) {
      kv.put({
        key: ACTIVE_BUILD_KEY,
        value: legacyActiveBuild,
      } satisfies KeyValueRecord<string>);
    }
  }
}

export function openRuntimeDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RUNTIME_DATABASE, RUNTIME_DATABASE_VERSION);
    request.onupgradeneeded = () => upgradeRuntimeDatabase(request);
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

function readLegacyActiveBuild(): string | null {
  try {
    return localStorage.getItem(ACTIVE_BUILD_KEY);
  } catch {
    return null;
  }
}

export function clearLegacyActiveBuild(): void {
  try {
    localStorage.removeItem(ACTIVE_BUILD_KEY);
  } catch {
    // IndexedDB is authoritative; inaccessible legacy storage is harmless.
  }
}
