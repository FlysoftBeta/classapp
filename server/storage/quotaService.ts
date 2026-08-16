import type { Database } from "better-sqlite3";
import {
  deleteOrphanQuotaItems,
  deleteQuotaGroup,
  deleteQuotaItem,
  findQuotaItem,
  listEvictionCandidates,
  quotaGroupBytes,
  quotaGroupPolicy,
  touchQuotaItem,
  upsertQuotaGroup,
  upsertQuotaItem,
  type EvictionWeights,
  type QuotaGroupPolicy,
  type QuotaItem,
} from "@/server/data/quota";

export type { QuotaGroupPolicy, QuotaItem };

export interface QuotaEvictionResult {
  group: string;
  evicted: number;
  reclaimedBytes: number;
}

export type QuotaEvictor = (item: QuotaItem) => Promise<boolean>;

export const DEFAULT_EVICTION_WEIGHTS: EvictionWeights = {
  bytes: 0.5,
  recency: 0.3,
  frequency: 0.2,
};

const CANDIDATE_BATCH = 50;
const MAX_SIZE_SWEEPS_PER_GROUP = 20;

/**
 * DB-backed quota accounting and eviction. It is intentionally stateless over
 * one database handle: request owners construct it on demand, and process
 * maintenance constructs its own instance. No Scope or Actor is involved.
 *
 * Candidate min/max normalization and ranking happen in SQL in
 * `server/data/quota`; this loop only receives bounded ranked batches and
 * never materializes a whole group in Node.js.
 */
export class QuotaService {
  constructor(private readonly db: Database) {}

  configure(policy: QuotaGroupPolicy): void {
    upsertQuotaGroup(this.db, policy);
  }

  removeGroup(group: string): void {
    deleteQuotaGroup(this.db, group);
  }

  upsert(group: string, itemKey: string, bytes: number, now = Date.now()): void {
    if (bytes < 0) throw new Error("Quota item bytes must be non-negative");
    upsertQuotaItem(this.db, { groupName: group, itemKey, bytes, now });
  }

  touch(group: string, itemKey: string, now = Date.now()): void {
    touchQuotaItem(this.db, group, itemKey, now);
  }

  remove(group: string, itemKey: string): void {
    deleteQuotaItem(this.db, group, itemKey);
  }

  usage(group: string): number {
    return quotaGroupBytes(this.db, group);
  }

  /**
   * Age sweep first, then high-watermark sweep. Only registered evictor groups
   * are visited, because groups are dynamic and unregistered groups are pure
   * accounting. Orphan accounting rows are swept before policy work.
   */
  async reconcile(
    evictors: ReadonlyMap<string, QuotaEvictor>,
    input: {
      now?: number;
      limitPerGroup?: number;
      weights?: EvictionWeights;
    } = {},
  ): Promise<QuotaEvictionResult[]> {
    const now = input.now ?? Date.now();
    const limitPerGroup = input.limitPerGroup ?? 200;
    const weights = input.weights ?? DEFAULT_EVICTION_WEIGHTS;
    deleteOrphanQuotaItems(this.db);
    const results: QuotaEvictionResult[] = [];

    for (const [groupName, evictor] of evictors) {
      const group = quotaGroupPolicy(this.db, groupName);
      if (!group) continue;
      let evicted = 0;
      let reclaimed = 0;
      const tryEvict = async (item: QuotaItem): Promise<boolean> => {
        if (evicted >= limitPerGroup) return false;
        const current = findQuotaItem(this.db, groupName, item.itemKey);
        if (
          !current ||
          current.bytes !== item.bytes ||
          current.touchTimeMs !== item.touchTimeMs
        ) {
          return false;
        }
        if (!(await evictor(current))) return false;
        // A successful owner eviction invalidates the accounting row even if
        // the owner forgot to unregister it; object bytes are gone either way.
        deleteQuotaItem(this.db, groupName, item.itemKey);
        evicted += 1;
        reclaimed += current.bytes;
        return true;
      };

      if (group.minAgeMs > 0) {
        const candidates = listEvictionCandidates(
          this.db,
          groupName,
          weights,
          {
            olderThanMs: now - group.minAgeMs,
            limit: limitPerGroup,
          },
        );
        for (const candidate of candidates) await tryEvict(candidate);
      }

      if (group.maxBytes > 0) {
        const target = Math.floor(group.maxBytes * group.targetRatio);
        for (
          let sweep = 0;
          sweep < MAX_SIZE_SWEEPS_PER_GROUP &&
          this.usage(groupName) > group.maxBytes &&
          evicted < limitPerGroup;
          sweep += 1
        ) {
          const candidates = listEvictionCandidates(
            this.db,
            groupName,
            weights,
            { limit: CANDIDATE_BATCH },
          );
          let progress = false;
          for (const candidate of candidates) {
            if (this.usage(groupName) <= target) break;
            if (await tryEvict(candidate)) progress = true;
          }
          if (!progress) break;
        }
      }

      if (evicted > 0) {
        results.push({
          group: groupName,
          evicted,
          reclaimedBytes: reclaimed,
        });
      }
    }
    return results;
  }
}
