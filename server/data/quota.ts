import type { Database } from "better-sqlite3";

export interface QuotaGroupPolicy {
  name: string;
  maxBytes: number;
  targetRatio: number;
  minAgeMs: number;
}

export interface QuotaItem {
  groupName: string;
  itemKey: string;
  bytes: number;
  touchTimeMs: number;
  touchFreq: number;
  createdAtMs: number;
}

export interface QuotaItemInput {
  groupName: string;
  itemKey: string;
  bytes: number;
  now: number;
}

export interface EvictionWeights {
  bytes: number;
  recency: number;
  frequency: number;
}

export interface QuotaRanges {
  minBytes: number;
  maxBytes: number;
  minTouchTimeMs: number;
  maxTouchTimeMs: number;
  minTouchFreq: number;
  maxTouchFreq: number;
}

interface QuotaGroupRow {
  name: string;
  max_bytes: number;
  target_ratio: number;
  min_age_ms: number;
}

interface QuotaItemRow {
  group_name: string;
  item_key: string;
  bytes: number;
  touch_time_ms: number;
  touch_freq: number;
  created_at_ms: number;
}

interface QuotaRangeRow {
  min_bytes: number | null;
  max_bytes: number | null;
  min_touch: number | null;
  max_touch: number | null;
  min_freq: number | null;
  max_freq: number | null;
}

export function quotaGroupPolicy(
  db: Database,
  name: string,
): QuotaGroupPolicy | null {
  const row = db
    .prepare(
      `SELECT name, max_bytes, target_ratio, min_age_ms
         FROM storage_eviction_groups WHERE name = ?`,
    )
    .get(name) as QuotaGroupRow | undefined;
  if (!row) return null;
  return {
    name: row.name,
    maxBytes: row.max_bytes,
    targetRatio: row.target_ratio,
    minAgeMs: row.min_age_ms,
  };
}

export function upsertQuotaGroup(
  db: Database,
  policy: QuotaGroupPolicy,
): void {
  db.prepare(
    `INSERT INTO storage_eviction_groups (name, max_bytes, target_ratio, min_age_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       max_bytes = excluded.max_bytes,
       target_ratio = excluded.target_ratio,
       min_age_ms = excluded.min_age_ms,
       updated_at = datetime('now')`,
  ).run(policy.name, policy.maxBytes, policy.targetRatio, policy.minAgeMs);
}

export function deleteQuotaGroup(db: Database, name: string): void {
  db.prepare("DELETE FROM storage_eviction_groups WHERE name = ?").run(name);
}

/** Sweep accounting rows whose group was removed without a cascade path. */
export function deleteOrphanQuotaItems(db: Database): number {
  const result = db
    .prepare(
      `DELETE FROM storage_quota_items
        WHERE group_name NOT IN (SELECT name FROM storage_eviction_groups)`,
    )
    .run();
  return result.changes;
}

/**
 * Persist a touch. The frequency half-life uses the caller-provided monotonic
 * clock value exactly as specified:
 *   freq' = (freq + (now - previousTouchTime)) / 2
 * A same-millisecond touch is advanced by one millisecond so it still counts.
 */
export function upsertQuotaItem(db: Database, input: QuotaItemInput): void {
  const existing = findQuotaItem(db, input.groupName, input.itemKey);
  if (!existing) {
    db.prepare(
      `INSERT INTO storage_quota_items
         (group_name, item_key, bytes, touch_time_ms, touch_freq, created_at_ms)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(input.groupName, input.itemKey, input.bytes, input.now, input.now);
    return;
  }
  const nextTouch = Math.max(input.now, existing.touchTimeMs + 1);
  const nextFreq =
    (existing.touchFreq + (nextTouch - existing.touchTimeMs)) / 2;
  db.prepare(
    `UPDATE storage_quota_items
        SET bytes = ?, touch_time_ms = ?, touch_freq = ?
      WHERE group_name = ? AND item_key = ?`,
  ).run(input.bytes, nextTouch, nextFreq, input.groupName, input.itemKey);
}

export function touchQuotaItem(
  db: Database,
  groupName: string,
  itemKey: string,
  now: number,
): void {
  const existing = findQuotaItem(db, groupName, itemKey);
  if (!existing) return;
  upsertQuotaItem(db, {
    groupName,
    itemKey,
    bytes: existing.bytes,
    now,
  });
}

export function deleteQuotaItem(
  db: Database,
  groupName: string,
  itemKey: string,
): void {
  db.prepare(
    "DELETE FROM storage_quota_items WHERE group_name = ? AND item_key = ?",
  ).run(groupName, itemKey);
}

export function findQuotaItem(
  db: Database,
  groupName: string,
  itemKey: string,
): QuotaItem | null {
  const row = db
    .prepare(
      `SELECT group_name, item_key, bytes, touch_time_ms, touch_freq, created_at_ms
         FROM storage_quota_items
        WHERE group_name = ? AND item_key = ?`,
    )
    .get(groupName, itemKey) as QuotaItemRow | undefined;
  return row ? rowToQuotaItem(row) : null;
}

export function quotaGroupBytes(db: Database, groupName: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(bytes), 0) AS total
         FROM storage_quota_items WHERE group_name = ?`,
    )
    .get(groupName) as { total: number };
  return row.total;
}

/** Min/max normalization ranges, computed by SQL over the group indexes. */
export function quotaRanges(
  db: Database,
  groupName: string,
  olderThanMs?: number,
): QuotaRanges {
  const filters = olderThanMs === undefined ? "" : "AND touch_time_ms <= ?";
  const args =
    olderThanMs === undefined ? [groupName] : [groupName, olderThanMs];
  const row = db
    .prepare(
      `SELECT MIN(bytes)         AS min_bytes,
              MAX(bytes)         AS max_bytes,
              MIN(touch_time_ms) AS min_touch,
              MAX(touch_time_ms) AS max_touch,
              MIN(touch_freq)    AS min_freq,
              MAX(touch_freq)    AS max_freq
         FROM storage_quota_items
        WHERE group_name = ? ${filters}`,
    )
    .get(...args) as QuotaRangeRow;
  if (
    row.min_bytes === null ||
    row.max_bytes === null ||
    row.min_touch === null ||
    row.max_touch === null ||
    row.min_freq === null ||
    row.max_freq === null
  ) {
    return {
      minBytes: 0,
      maxBytes: 0,
      minTouchTimeMs: 0,
      maxTouchTimeMs: 0,
      minTouchFreq: 0,
      maxTouchFreq: 0,
    };
  }
  return {
    minBytes: row.min_bytes,
    maxBytes: row.max_bytes,
    minTouchTimeMs: row.min_touch,
    maxTouchTimeMs: row.max_touch,
    minTouchFreq: row.min_freq,
    maxTouchFreq: row.max_freq,
  };
}

const SCORE_SQL = `
  SELECT i.group_name, i.item_key, i.bytes, i.touch_time_ms, i.touch_freq,
         i.created_at_ms,
         (
           ? * CASE WHEN s.max_bytes = s.min_bytes THEN 0.5
                    ELSE CAST(i.bytes - s.min_bytes AS REAL) /
                         (s.max_bytes - s.min_bytes) END
         + ? * CASE WHEN s.max_touch = s.min_touch THEN 0.5
                    ELSE 1.0 - CAST(i.touch_time_ms - s.min_touch AS REAL) /
                         (s.max_touch - s.min_touch) END
         + ? * CASE WHEN s.max_freq = s.min_freq THEN 0.5
                    ELSE 1.0 - CAST(i.touch_freq - s.min_freq AS REAL) /
                         (s.max_freq - s.min_freq) END
         ) AS score
    FROM storage_quota_items i
    JOIN (
      SELECT MIN(bytes) AS min_bytes, MAX(bytes) AS max_bytes,
             MIN(touch_time_ms) AS min_touch, MAX(touch_time_ms) AS max_touch,
             MIN(touch_freq) AS min_freq, MAX(touch_freq) AS max_freq
        FROM storage_quota_items
       WHERE group_name = ? $RANGE_FILTER
    ) s ON 1 = 1
   WHERE i.group_name = ? $ITEM_FILTER
   ORDER BY score DESC, i.touch_time_ms ASC, i.item_key ASC
   LIMIT ?
`;

/**
 * Bounded eviction ranking. Min/max normalization runs as one SQL aggregate
 * subquery backed by the per-group column indexes; Node.js only ever sees the
 * requested limit of ranked rows.
 */
export function listEvictionCandidates(
  db: Database,
  groupName: string,
  weights: EvictionWeights,
  input: { olderThanMs?: number; limit: number },
): QuotaItem[] {
  const rangeFilter =
    input.olderThanMs === undefined ? "" : "AND touch_time_ms <= ?";
  const sql = SCORE_SQL.replace("$RANGE_FILTER", rangeFilter).replace(
    "$ITEM_FILTER",
    rangeFilter,
  );
  const older = input.olderThanMs === undefined ? [] : [input.olderThanMs];
  const args = [
    weights.bytes,
    weights.recency,
    weights.frequency,
    groupName,
    ...older,
    groupName,
    ...older,
    input.limit,
  ];
  const rows = db.prepare(sql).all(...args) as QuotaItemRow[];
  return rows.map(rowToQuotaItem);
}

function rowToQuotaItem(row: QuotaItemRow): QuotaItem {
  return {
    groupName: row.group_name,
    itemKey: row.item_key,
    bytes: row.bytes,
    touchTimeMs: row.touch_time_ms,
    touchFreq: row.touch_freq,
    createdAtMs: row.created_at_ms,
  };
}
