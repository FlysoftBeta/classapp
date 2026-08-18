import path from "node:path";
import type { Database } from "better-sqlite3";
import { BlobStore } from "./blobStore";
import { QuotaService, type QuotaEvictor, type QuotaPoolPolicy } from "./quotaService";

/**
 * Process-bound storage mechanisms. BlobStore is shared by request Services;
 * quota pools and their evictors are passed in by the owning mechanism.
 */
export class StorageRuntime {
  readonly blobs: BlobStore;
  readonly quota: QuotaService;
  private readonly evictors = new Map<string, QuotaEvictor>();

  constructor(db: Database, dataRoot: string) {
    this.blobs = new BlobStore(path.join(dataRoot, "storage"));
    this.quota = new QuotaService(db);
  }

  /** @deprecated Use `blobs`. */
  get objects(): BlobStore {
    return this.blobs;
  }

  registerEvictor(
    pool: string,
    policy: QuotaPoolPolicy,
    evictor: QuotaEvictor,
  ): void {
    if (policy.name !== pool) {
      throw new Error(
        `Quota policy ${policy.name} does not match pool ${pool}`,
      );
    }
    this.quota.configure(policy);
    this.evictors.set(pool, evictor);
  }

  async start(): Promise<void> {
    await this.reconcileStorage();
  }

  async reconcileStorage(): Promise<void> {
    await this.blobs.gc();
    await this.quota.reconcile(this.evictors);
  }
}
