import type { Database } from "better-sqlite3";
import {
  deleteQuotaItem,
  deleteQuotaPool,
  findQuotaItem,
  listCacheEvictionCandidates,
  quotaPoolPolicy,
  quotaPoolWeight,
  touchQuotaItem,
  upsertQuotaItem,
  upsertQuotaPool,
  type QuotaClass,
  type QuotaItem,
  type QuotaPoolPolicy,
} from "@/server/data/quota";

export type { QuotaClass, QuotaItem, QuotaPoolPolicy };

export interface QuotaEvictionResult {
  pool: string;
  evicted: number;
  reclaimedWeight: number;
}

export type QuotaEvictor = (item: QuotaItem) => Promise<boolean>;

const CANDIDATE_BATCH = 50;
const MAX_SIZE_SWEEPS_PER_POOL = 20;

/**
 * Compare-and-skip for one reconcile candidate. A touch, pin, class change,
 * or rematerialized weight that lands before this check must suppress eviction.
 */
export function quotaCandidateIsCurrent(
  candidate: QuotaItem,
  current: QuotaItem | null,
  now: number,
): current is QuotaItem {
  return (
    current !== null &&
    current.class === "cache" &&
    current.weight === candidate.weight &&
    current.touchedAtMs === candidate.touchedAtMs &&
    current.heat === candidate.heat &&
    current.pinUntilMs <= now
  );
}

/**
 * DB-backed quota accounting. It never opens or deletes files. Request owners
 * construct it on demand; process maintenance constructs its own instance.
 */
export class QuotaService {
  constructor(private readonly db: Database) {}

  configure(policy: QuotaPoolPolicy): void {
    upsertQuotaPool(this.db, policy);
  }

  removePool(pool: string): void {
    deleteQuotaPool(this.db, pool);
  }

  account(
    pool: string,
    itemId: string,
    input: {
      weight: number;
      class: QuotaClass;
      now?: number;
      pinUntilMs?: number;
      heat?: number;
    },
  ): void {
    upsertQuotaItem(this.db, {
      pool,
      itemId,
      class: input.class,
      weight: input.weight,
      now: input.now ?? Date.now(),
      pinUntilMs: input.pinUntilMs,
      heat: input.heat,
    });
  }

  touch(
    pool: string,
    itemId: string,
    intensity = 1,
    now = Date.now(),
  ): void {
    const policy = quotaPoolPolicy(this.db, pool);
    if (!policy) return;
    touchQuotaItem(this.db, pool, itemId, intensity, now, policy.halfLifeMs);
  }

  release(pool: string, itemId: string): void {
    deleteQuotaItem(this.db, pool, itemId);
  }

  cacheUsage(pool: string): number {
    return quotaPoolWeight(this.db, pool, "cache");
  }

  /**
   * Size sweep of cache items for registered evictor pools. Durable rows are
   * never candidates. The evictor must compare-and-delete domain state and
   * call release itself; this loop only counts successes.
   */
  async reconcile(
    evictors: ReadonlyMap<string, QuotaEvictor>,
    input: { now?: number; limitPerPool?: number } = {},
  ): Promise<QuotaEvictionResult[]> {
    const now = input.now ?? Date.now();
    const limitPerPool = input.limitPerPool ?? 200;
    const results: QuotaEvictionResult[] = [];

    for (const [poolName, evictor] of evictors) {
      const pool = quotaPoolPolicy(this.db, poolName);
      if (!pool || pool.maxWeight <= 0) continue;
      let evicted = 0;
      let reclaimed = 0;
      const target = Math.floor(pool.maxWeight * pool.targetRatio);

      for (
        let sweep = 0;
        sweep < MAX_SIZE_SWEEPS_PER_POOL &&
        this.cacheUsage(poolName) > pool.maxWeight &&
        evicted < limitPerPool;
        sweep += 1
      ) {
        const candidates = listCacheEvictionCandidates(
          this.db,
          poolName,
          pool.halfLifeMs,
          { now, limit: CANDIDATE_BATCH },
        );
        let progress = false;
        for (const candidate of candidates) {
          if (this.cacheUsage(poolName) <= target) break;
          if (evicted >= limitPerPool) break;
          const current = findQuotaItem(this.db, poolName, candidate.itemId);
          if (!quotaCandidateIsCurrent(candidate, current, now)) continue;
          if (!(await evictor(current))) continue;
          evicted += 1;
          reclaimed += current.weight;
          progress = true;
        }
        if (!progress) break;
      }

      if (evicted > 0) {
        results.push({
          pool: poolName,
          evicted,
          reclaimedWeight: reclaimed,
        });
      }
    }
    return results;
  }
}
