import path from "node:path";
import type { Database } from "better-sqlite3";
import { ObjectStore } from "./objectStore";
import {
  QuotaService,
  type QuotaEvictor,
  type QuotaGroupPolicy,
} from "./quotaService";

/**
 * Process-bound storage mechanisms. The ObjectStore is shared by request
 * Services; quota groups and their evictors are passed in dynamically by the
 * owning mechanism, so quota never reaches into unrelated tables.
 */
export class StorageRuntime {
  readonly objects: ObjectStore;
  readonly quota: QuotaService;
  private readonly evictors = new Map<string, QuotaEvictor>();

  constructor(
    db: Database,
    dataRoot: string,
  ) {
    this.objects = new ObjectStore(path.join(dataRoot, "storage"));
    this.quota = new QuotaService(db);
  }

  registerEvictor(
    group: string,
    policy: QuotaGroupPolicy,
    evictor: QuotaEvictor,
  ): void {
    if (policy.name !== group) {
      throw new Error(`Quota policy ${policy.name} does not match group ${group}`);
    }
    this.quota.configure(policy);
    this.evictors.set(group, evictor);
  }

  async start(): Promise<void> {
    await this.objects.reconcile();
  }

  async reconcileStorage(): Promise<void> {
    await this.objects.reconcile();
    await this.quota.reconcile(this.evictors);
  }
}
