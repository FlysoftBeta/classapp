import { runtimeDatabase } from "@/client/data/idb";
import { handleOfflineQuotaPressure } from "@/client/data/repository";
import { extentFiles } from "@/client/data/files";
import { captureDetachedClientIncident } from "@/client/interact/clientIncidents";

const START_RATIO = 0.9;
const TARGET_RATIO = 0.8;
const MAX_ROUNDS = 4;

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
    if (
      !force &&
      (!current.quota || current.usage / current.quota < START_RATIO)
    )
      return;

    let lastUsage = current.usage;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const targetBytes = current.quota
        ? Math.max(
            force ? 16 * 1024 * 1024 : 0,
            current.usage - current.quota * TARGET_RATIO,
          )
        : 64 * 1024 * 1024;
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
      if (!freed) return;
      current = await estimate();
      if (!current.quota || current.usage / current.quota <= TARGET_RATIO)
        return;
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
