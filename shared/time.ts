/**
 * Shared time helpers. SQLite `datetime('now')` stores UTC as
 * "YYYY-MM-DD HH:MM:SS" (no timezone marker). These helpers keep parsing and
 * formatting consistent across server and client code.
 */

/** Parse a DB timestamp (with or without trailing "Z") as UTC. */
export function parseDbTime(s: string): Date {
  return new Date(s.endsWith("Z") ? s : s + "Z");
}

/** Format a Date as the DB timestamp format "YYYY-MM-DD HH:MM:SS" (UTC). */
export function toDbTimestamp(date: Date | number): string {
  return new Date(date).toISOString().replace("T", " ").slice(0, 19);
}

/** True if the given DB timestamp is still in the future. */
export function isFuture(s: string | null | undefined): boolean {
  if (!s) return false;
  return parseDbTime(s) > new Date();
}

/** Human-readable "X 天 Y 小时 Z 分钟" remaining until the given DB timestamp. */
export function formatRemaining(until: string): string {
  const diffMs = parseDbTime(until).getTime() - Date.now();
  if (diffMs <= 0) return "已解除";

  const totalSec = Math.ceil(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins} 分钟`);
  return parts.join(" ");
}
