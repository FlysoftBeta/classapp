import { type StoreName } from "./schema";
import type { ShellStoreName } from "./shellSchema";
import { openApplicationDatabase } from "./migration";

export interface DatabaseLease {
  readonly db: IDBDatabase;
  release(): void;
}

type RuntimeStoreName = StoreName | ShellStoreName;
type ChangeListener = (stores: ReadonlySet<RuntimeStoreName>) => void;

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

  notify(stores: Iterable<RuntimeStoreName>): void {
    const changed = new Set(stores);
    for (const listener of this.listeners) {
      try {
        listener(changed);
      } catch (error) {
        // A post-commit observer cannot turn a committed transaction into an
        // apparent failure for its caller. Re-throw on a detached task so the
        // global Incident boundary can retain the original observer panic.
        setTimeout(() => {
          throw error;
        }, 0);
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
      void openApplicationDatabase().then(
        (db) => {
          if (settled || epoch !== this.openEpoch) {
            db.close();
            if (!settled) {
              settled = true;
              reject(
                new Error("IndexedDB connection was closed while opening"),
              );
            }
            return;
          }
          settled = true;
          db.onversionchange = () => this.closeNow();
          db.onclose = () => {
            if (this.connection === db) this.connection = null;
          };
          this.connection = db;
          resolve(db);
        },
        (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
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
  stores: RuntimeStoreName | RuntimeStoreName[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const names = typeof stores === "string" ? [stores] : stores;
  const lease = await runtimeDatabase.acquire();
  try {
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
    }
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
