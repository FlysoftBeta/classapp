import type { Database } from "better-sqlite3";

export type QuotaClass = "cache" | "durable";

export interface QuotaPoolPolicy {
  name: string;
  /** Cache high watermark in weight units (usually bytes). 0 disables size eviction. */
  maxWeight: number;
  targetRatio: number;
  halfLifeMs: number;
}

export interface QuotaItem {
  pool: string;
  itemId: string;
  class: QuotaClass;
  weight: number;
  heat: number;
  touchedAtMs: number;
  pinUntilMs: number;
  createdAtMs: number;
}

export interface QuotaItemInput {
  pool: string;
  itemId: string;
  class: QuotaClass;
  weight: number;
  now: number;
  /** Admission pin so a fresh cache item is not immediately evicted. */
  pinUntilMs?: number;
  /** Starting heat; defaults to 1 so a new item is not colder than a first touch. */
  heat?: number;
}

const HEAT_EPSILON = 1e-9;

export function heatNow(
  heat: number,
  touchedAtMs: number,
  now: number,
  halfLifeMs: number,
): number {
  const delta = Math.max(0, now - touchedAtMs);
  if (halfLifeMs <= 0) return Math.max(0, heat);
  return Math.max(0, heat) * 0.5 ** (delta / halfLifeMs);
}

export function evictScore(weight: number, heat: number): number {
  return weight / (heat + HEAT_EPSILON);
}

interface PoolRow {
  name: string;
  max_weight: number;
  target_ratio: number;
  half_life_ms: number;
}

interface ItemRow {
  pool: string;
  item_id: string;
  class: QuotaClass;
  weight: number;
  heat: number;
  touched_at_ms: number;
  pin_until_ms: number;
  created_at_ms: number;
}

function rowToItem(row: ItemRow): QuotaItem {
  return {
    pool: row.pool,
    itemId: row.item_id,
    class: row.class,
    weight: row.weight,
    heat: row.heat,
    touchedAtMs: row.touched_at_ms,
    pinUntilMs: row.pin_until_ms,
    createdAtMs: row.created_at_ms,
  };
}

export function quotaPoolPolicy(
  db: Database,
  name: string,
): QuotaPoolPolicy | null {
  const row = db
    .prepare(
      `SELECT name, max_weight, target_ratio, half_life_ms
         FROM storage_quota_pools WHERE name = ?`,
    )
    .get(name) as PoolRow | undefined;
  if (!row) return null;
  return {
    name: row.name,
    maxWeight: row.max_weight,
    targetRatio: row.target_ratio,
    halfLifeMs: row.half_life_ms,
  };
}

export function upsertQuotaPool(db: Database, policy: QuotaPoolPolicy): void {
  db.prepare(
    `INSERT INTO storage_quota_pools (name, max_weight, target_ratio, half_life_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       max_weight = excluded.max_weight,
       target_ratio = excluded.target_ratio,
       half_life_ms = excluded.half_life_ms,
       updated_at = datetime('now')`,
  ).run(policy.name, policy.maxWeight, policy.targetRatio, policy.halfLifeMs);
}

export function deleteQuotaPool(db: Database, name: string): void {
  db.prepare("DELETE FROM storage_quota_pools WHERE name = ?").run(name);
}

export function findQuotaItem(
  db: Database,
  pool: string,
  itemId: string,
): QuotaItem | null {
  const row = db
    .prepare(
      `SELECT pool, item_id, class, weight, heat, touched_at_ms, pin_until_ms,
              created_at_ms
         FROM storage_quota_items
        WHERE pool = ? AND item_id = ?`,
    )
    .get(pool, itemId) as ItemRow | undefined;
  return row ? rowToItem(row) : null;
}

/**
 * Insert or refresh weight/class. Heat and touched_at are preserved on
 * conflict so a byte-size backfill cannot rewind the clock.
 */
export function upsertQuotaItem(db: Database, input: QuotaItemInput): void {
  if (input.weight < 0) throw new Error("Quota item weight must be non-negative");
  const existing = findQuotaItem(db, input.pool, input.itemId);
  if (!existing) {
    const heat = input.heat ?? 1;
    db.prepare(
      `INSERT INTO storage_quota_items
         (pool, item_id, class, weight, heat, touched_at_ms, pin_until_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.pool,
      input.itemId,
      input.class,
      input.weight,
      heat,
      input.now,
      input.pinUntilMs ?? 0,
      input.now,
    );
    return;
  }
  db.prepare(
    `UPDATE storage_quota_items
        SET class = ?, weight = ?,
            pin_until_ms = CASE WHEN ? > pin_until_ms THEN ? ELSE pin_until_ms END
      WHERE pool = ? AND item_id = ?`,
  ).run(
    input.class,
    input.weight,
    input.pinUntilMs ?? 0,
    input.pinUntilMs ?? 0,
    input.pool,
    input.itemId,
  );
}

export function touchQuotaItem(
  db: Database,
  pool: string,
  itemId: string,
  intensity: number,
  now: number,
  halfLifeMs: number,
): void {
  if (intensity < 0) throw new Error("Touch intensity must be non-negative");
  const existing = findQuotaItem(db, pool, itemId);
  if (!existing) return;
  const nextTouch = Math.max(now, existing.touchedAtMs);
  const nextHeat =
    heatNow(existing.heat, existing.touchedAtMs, nextTouch, halfLifeMs) +
    intensity;
  db.prepare(
    `UPDATE storage_quota_items
        SET heat = ?, touched_at_ms = ?
      WHERE pool = ? AND item_id = ?`,
  ).run(nextHeat, nextTouch, pool, itemId);
}

export function deleteQuotaItem(
  db: Database,
  pool: string,
  itemId: string,
  expected?: Pick<QuotaItem, "weight" | "heat" | "touchedAtMs">,
): boolean {
  const result = expected
    ? db
        .prepare(
          `DELETE FROM storage_quota_items
            WHERE pool = ? AND item_id = ? AND weight = ? AND heat = ?
              AND touched_at_ms = ?`,
        )
        .run(
          pool,
          itemId,
          expected.weight,
          expected.heat,
          expected.touchedAtMs,
        )
    : db
        .prepare(
          "DELETE FROM storage_quota_items WHERE pool = ? AND item_id = ?",
        )
        .run(pool, itemId);
  return result.changes > 0;
}

export function quotaPoolWeight(
  db: Database,
  pool: string,
  itemClass?: QuotaClass,
): number {
  const row = itemClass
    ? (db
        .prepare(
          `SELECT COALESCE(SUM(weight), 0) AS total
             FROM storage_quota_items WHERE pool = ? AND class = ?`,
        )
        .get(pool, itemClass) as { total: number })
    : (db
        .prepare(
          `SELECT COALESCE(SUM(weight), 0) AS total
             FROM storage_quota_items WHERE pool = ?`,
        )
        .get(pool) as { total: number });
  return row.total;
}

/**
 * Cache candidates only, ranked by hold cost over current heat. Pins that have
 * not expired are skipped. Node computes heat so idle rows need no write.
 */
export function listCacheEvictionCandidates(
  db: Database,
  pool: string,
  halfLifeMs: number,
  input: { now: number; limit: number },
): QuotaItem[] {
  const rows = db
    .prepare(
      `SELECT pool, item_id, class, weight, heat, touched_at_ms, pin_until_ms,
              created_at_ms
         FROM storage_quota_items
        WHERE pool = ? AND class = 'cache' AND pin_until_ms <= ?
          AND weight > 0`,
    )
    .all(pool, input.now) as ItemRow[];
  return rows
    .map((row) => {
      const item = rowToItem(row);
      const heat = heatNow(item.heat, item.touchedAtMs, input.now, halfLifeMs);
      return { item, score: evictScore(item.weight, heat) };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.item.touchedAtMs - right.item.touchedAtMs ||
        left.item.itemId.localeCompare(right.item.itemId),
    )
    .slice(0, input.limit)
    .map((entry) => entry.item);
}
