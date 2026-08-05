import {
  openRuntimeDatabase,
  requestValue,
  transactionDone,
} from "./runtimeDatabase";

export type ResourceClass = "cache" | "persisted";

type QuotaPressureHandler = (bytesToFree: number) => Promise<number>;

interface ResourceRecord {
  key: string;
  body: Blob;
  size: number;
  touchedAt: number;
  resourceClass: ResourceClass;
}

/** Owns quota-aware transient cache and explicitly persistent resources. */
export class ResourceManager {
  private quotaPressureHandler: QuotaPressureHandler | null = null;
  private enforcingQuota = false;

  setQuotaPressureHandler(handler: QuotaPressureHandler): void {
    this.quotaPressureHandler = handler;
  }

  async persist(key: string, body: Blob): Promise<void> {
    await this.put(key, body, "persisted");
    await navigator.storage?.persist?.();
    await this.enforceQuota();
  }

  async cache(key: string, body: Blob): Promise<void> {
    await this.put(key, body, "cache");
    await this.enforceQuota();
  }

  async get(key: string): Promise<Blob | null> {
    const db = await openRuntimeDatabase();
    const tx = db.transaction("resources", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("resources");
    const record = (await requestValue(store.get(key))) as
      ResourceRecord | undefined;
    if (!record) {
      await done;
      return null;
    }
    record.touchedAt = Date.now();
    store.put(record);
    await done;
    return record.body;
  }

  async putJson<T>(
    key: string,
    value: T,
    resourceClass: ResourceClass = "cache",
  ): Promise<void> {
    const body = new Blob([JSON.stringify(value)], {
      type: "application/json",
    });
    if (resourceClass === "persisted") await this.persist(key, body);
    else await this.cache(key, body);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const body = await this.get(key);
    if (!body) return null;
    try {
      return JSON.parse(await body.text()) as T;
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<number> {
    const db = await openRuntimeDatabase();
    const tx = db.transaction("resources", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("resources");
    const record = (await requestValue(store.get(key))) as
      ResourceRecord | undefined;
    store.delete(key);
    await done;
    return record?.size ?? 0;
  }

  async keys(prefix = ""): Promise<string[]> {
    const db = await openRuntimeDatabase();
    const tx = db.transaction("resources", "readonly");
    const done = transactionDone(tx);
    const all = await requestValue(tx.objectStore("resources").getAllKeys());
    await done;
    return all.map(String).filter((key) => key.startsWith(prefix));
  }

  async quota(): Promise<{
    usage: number;
    quota: number;
    persistent: boolean;
  }> {
    const estimate = await navigator.storage?.estimate?.();
    const persistent = await navigator.storage?.persisted?.();
    return {
      usage: estimate?.usage ?? 0,
      quota: estimate?.quota ?? 0,
      persistent: persistent ?? false,
    };
  }

  private async put(key: string, body: Blob, resourceClass: ResourceClass) {
    const db = await openRuntimeDatabase();
    const tx = db.transaction("resources", "readwrite");
    const done = transactionDone(tx);
    tx.objectStore("resources").put({
      key,
      body,
      size: body.size,
      touchedAt: Date.now(),
      resourceClass,
    } satisfies ResourceRecord);
    await done;
  }

  private async enforceQuota(): Promise<void> {
    if (this.enforcingQuota) return;
    const { usage, quota } = await this.quota();
    if (!quota || usage / quota < 0.8) return;
    this.enforcingQuota = true;
    try {
      const db = await openRuntimeDatabase();
      const tx = db.transaction("resources", "readwrite");
      const done = transactionDone(tx);
      const store = tx.objectStore("resources");
      const all = (await requestValue(store.getAll())) as ResourceRecord[];
      const cache = all
        .filter((item) => item.resourceClass === "cache")
        .sort((a, b) => a.touchedAt - b.touchedAt);
      let projected = usage;
      for (const item of cache) {
        if (projected / quota < 0.65) break;
        store.delete(item.key);
        projected -= item.size;
      }
      await done;
      if (projected / quota >= 0.65 && this.quotaPressureHandler) {
        await this.quotaPressureHandler(projected - quota * 0.65);
      }
    } finally {
      this.enforcingQuota = false;
    }
  }
}

export const resourceManager = new ResourceManager();
