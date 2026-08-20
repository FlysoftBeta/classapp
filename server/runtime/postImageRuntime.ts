import type { Database } from "better-sqlite3";
import type { BlobStore } from "@/server/storage/blobStore";
import type { QuotaItem } from "@/server/storage/quotaService";
import {
  PostImageService,
  createPostImageService,
} from "@/server/services/postImagesService";
import { recordContainedServerIncident } from "@/server/services/incidentService";
import { BUILD_ID } from "@/server/infra/env";

const MAX_CONCURRENT = 2;
const WAIT_TIMEOUT_MS = 15_000;

interface ThumbWaiter {
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Process-lifetime post-image thumbnail jobs, stream leases, and cache
 * eviction. Does not capture Scope or Actor.
 */
export class PostImageRuntime {
  private readonly images: PostImageService;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, ThumbWaiter[]>();
  private readonly leases = new Map<string, number>();
  private readonly slotWaiters: Array<() => void> = [];
  private running = 0;

  constructor(
    private readonly db: Database,
    blobs: BlobStore,
  ) {
    this.images = createPostImageService(db, blobs);
  }

  quotaPolicy() {
    return this.images.quotaThumbPolicy();
  }

  acquireLease(imageId: string): () => void {
    this.leases.set(imageId, (this.leases.get(imageId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.leases.get(imageId) ?? 1) - 1;
      if (count <= 0) this.leases.delete(imageId);
      else this.leases.set(imageId, count);
    };
  }

  hasLease(imageId: string): boolean {
    return (this.leases.get(imageId) ?? 0) > 0;
  }

  ensureThumbnail(imageId: string): Promise<void> {
    const existing = this.jobs.get(imageId);
    if (existing) return existing;
    const job = this.runEnsure(imageId).finally(() => {
      if (this.jobs.get(imageId) === job) this.jobs.delete(imageId);
    });
    this.jobs.set(imageId, job);
    return job;
  }

  async waitUntilReady(
    imageId: string,
    timeoutMs = WAIT_TIMEOUT_MS,
  ): Promise<boolean> {
    const opened = await this.images.openThumb(imageId).catch(() => null);
    if (opened) return true;
    void this.ensureThumbnail(imageId).catch(() => undefined);
    await this.wait(imageId, timeoutMs);
    const ready = await this.images.openThumb(imageId).catch(() => null);
    return ready !== null;
  }

  async evict(imageId: string, snapshot?: QuotaItem): Promise<boolean> {
    if (this.hasLease(imageId)) return false;
    return this.images.evictThumb(imageId, snapshot);
  }

  async reconcile(): Promise<number> {
    return this.images.reconcile();
  }

  private async runEnsure(imageId: string): Promise<void> {
    await this.acquireSlot();
    try {
      const started = this.images.beginThumbMaterialization(imageId);
      if (started.kind !== "start") {
        if (started.kind === "ready") this.resolveWaiters(imageId);
        return;
      }
      try {
        await this.images.materializeThumb(imageId, started.generation);
      } catch (error) {
        recordContainedServerIncident(this.db, BUILD_ID, error, {
          component: "post-image",
          phase: "thumbnail",
          image_id: imageId,
        });
      }
      this.resolveWaiters(imageId);
    } finally {
      this.releaseSlot();
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.running < MAX_CONCURRENT) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.slotWaiters.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.running = Math.max(0, this.running - 1);
    const next = this.slotWaiters.shift();
    next?.();
  }

  private wait(imageId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const waiter: ThumbWaiter = {
        resolve,
        timeout: setTimeout(() => {
          this.removeWaiter(imageId, waiter);
          resolve();
        }, timeoutMs),
      };
      const current = this.waiters.get(imageId) ?? [];
      current.push(waiter);
      this.waiters.set(imageId, current);
    });
  }

  private removeWaiter(imageId: string, waiter: ThumbWaiter): void {
    const current = this.waiters.get(imageId) ?? [];
    const remaining = current.filter((entry) => entry !== waiter);
    if (remaining.length) this.waiters.set(imageId, remaining);
    else this.waiters.delete(imageId);
    clearTimeout(waiter.timeout);
  }

  private resolveWaiters(imageId: string): void {
    const waiters = this.waiters.get(imageId) ?? [];
    this.waiters.delete(imageId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }
}
