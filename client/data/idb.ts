import {
  RUNTIME_DATABASE,
  RUNTIME_DATABASE_VERSION,
  upgradeRuntimeDatabase,
  type StoreName,
} from "./schema";

export interface DatabaseLease {
  readonly db: IDBDatabase;
  release(): void;
}

type ChangeListener = (stores: ReadonlySet<StoreName>) => void;

class RuntimeDatabase {
  private connection: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  private leases = 0;
  private closeTimer: number | null = null;
  private openEpoch = 0;
  private readonly listeners = new Set<ChangeListener>();

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => this.closeNow());
    }
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(stores: Iterable<StoreName>): void {
    const changed = new Set(stores);
    for (const listener of this.listeners) {
      try {
        listener(changed);
      } catch {
        // A post-commit observer cannot turn a committed transaction into an
        // apparent failure for its caller.
      }
    }
  }

  async acquire(): Promise<DatabaseLease> {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    const db = await this.open();
    this.leases += 1;
    let released = false;
    return {
      db,
      release: () => {
        if (released) return;
        released = true;
        this.leases -= 1;
        this.scheduleClose();
      },
    };
  }

  closeNow(): void {
    this.openEpoch += 1;
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.connection?.close();
    this.connection = null;
    this.opening = null;
  }

  private open(): Promise<IDBDatabase> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.opening) return this.opening;
    const epoch = this.openEpoch;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      let blockedTimer: number | null = null;
      const request = indexedDB.open(
        RUNTIME_DATABASE,
        RUNTIME_DATABASE_VERSION,
      );
      request.onupgradeneeded = (event) =>
        upgradeRuntimeDatabase(request, event.oldVersion);
      request.onblocked = () => {
        blockedTimer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("IndexedDB upgrade is blocked by another page"));
        }, 5_000);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        if (blockedTimer !== null) clearTimeout(blockedTimer);
        reject(request.error);
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled || epoch !== this.openEpoch) {
          db.close();
          if (!settled) {
            settled = true;
            reject(new Error("IndexedDB connection was closed while opening"));
          }
          return;
        }
        settled = true;
        if (blockedTimer !== null) clearTimeout(blockedTimer);
        db.onversionchange = () => this.closeNow();
        db.onclose = () => {
          if (this.connection === db) this.connection = null;
        };
        this.connection = db;
        resolve(db);
      };
    });
    this.opening = opening;
    const clearOpening = () => {
      if (this.opening === opening) this.opening = null;
    };
    void opening.then(clearOpening, clearOpening);
    return opening;
  }

  private scheduleClose(): void {
    if (this.leases !== 0 || this.closeTimer !== null) return;
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      if (this.leases === 0) this.closeNow();
    }, 250);
  }
}

export const runtimeDatabase = new RuntimeDatabase();

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionResult(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

export async function runTransaction<T>(
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const names = typeof stores === "string" ? [stores] : stores;
  const lease = await runtimeDatabase.acquire();
  const tx = lease.db.transaction(names, mode);
  const done = transactionResult(tx);
  try {
    const value = await run(tx);
    await done;
    if (mode === "readwrite") runtimeDatabase.notify(names);
    return value;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already have aborted or committed.
    }
    await done.catch(() => undefined);
    throw error;
  } finally {
    lease.release();
  }
}

export function cursorRows<T>(request: IDBRequest<IDBCursorWithValue | null>) {
  return new Promise<T[]>((resolve, reject) => {
    const rows: T[] = [];
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(rows);
        return;
      }
      rows.push(cursor.value as T);
      cursor.continue();
    };
  });
}
