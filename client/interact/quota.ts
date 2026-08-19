import { runtimeDatabase } from "@/client/data/idb";
import { handleOfflineQuotaPressure } from "@/client/data/repository";
import { handleMediaQuotaPressure } from "@/client/data/media";
import { extentFiles } from "@/client/data/files";
import { captureDetachedClientIncident } from "@/client/interact/clientIncidents";
import {
  QUOTA_MAX_ROUNDS,
  quotaEvictionTargetBytes,
  quotaUsageAtOrBelowTarget,
} from "@/client/data/quotaPolicy";

async function estimate(): Promise<{ usage: number; quota: number }> {
  const value = await navigator.storage?.estimate?.();
  return {
    usage: value?.usage ?? 0,
    quota: value?.quota ?? 0,
  };
}

class QuotaController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;

  schedule(): void {
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enforce();
    }, 500);
  }

  async enforce(force = false, excludeArticleId?: string): Promise<void> {
    if (this.running) return this.running;
    const run = this.run(force, excludeArticleId).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async run(force: boolean, excludeArticleId?: string): Promise<void> {
    await extentFiles.collectOrphans().catch((error) => {
      captureDetachedClientIncident("quota.orphan-collection", error);
      return 0;
    });
    let current = await estimate();
    let lastUsage = current.usage;
    for (let round = 0; round < QUOTA_MAX_ROUNDS; round += 1) {
      const targetBytes = quotaEvictionTargetBytes({
        usage: current.usage,
        quota: current.quota,
        force,
      });
      if (!targetBytes) return;
      const excludedArticles = excludeArticleId
        ? new Set([excludeArticleId])
        : undefined;
      let freed = await handleOfflineQuotaPressure(
        targetBytes,
        false,
        excludedArticles,
      );
      if (freed < targetBytes) {
        freed += await handleOfflineQuotaPressure(
          targetBytes - freed,
          true,
          excludedArticles,
        );
      }
      if (freed < targetBytes) {
        freed += await handleMediaQuotaPressure(targetBytes - freed);
      }
      if (!freed) return;
      current = await estimate();
      if (quotaUsageAtOrBelowTarget(current.usage, current.quota)) return;
      // Browser usage is approximate and LevelDB compaction may lag. Stop when
      // another logical deletion round no longer changes the estimate.
      if (current.usage >= lastUsage) return;
      lastUsage = current.usage;
    }
  }
}

const quotaController = new QuotaController();

function isQuotaExceeded(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "QuotaExceededError";
}

export function startQuotaController(): () => void {
  const unsubscribe = runtimeDatabase.subscribe(() =>
    quotaController.schedule(),
  );
  quotaController.schedule();
  return unsubscribe;
}

export async function requestPersistentStorage(): Promise<boolean> {
  return (await navigator.storage?.persist?.()) ?? false;
}

export async function recoverFromQuotaExceeded<T>(
  run: () => Promise<T>,
  excludeArticleId?: string,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(await reclaimAfterQuotaExceeded(error, excludeArticleId)))
      throw error;
    return run();
  }
}

/** Reclaim space without replaying a one-shot input such as a network stream. */
export async function reclaimAfterQuotaExceeded(
  error: unknown,
  excludeArticleId?: string,
): Promise<boolean> {
  if (!isQuotaExceeded(error)) return false;
  await quotaController.enforce(true, excludeArticleId);
  return true;
}
