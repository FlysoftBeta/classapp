import type BetterSqlite3 from "better-sqlite3";
import { getUserConfigValue, upsertUserConfigValue } from "./userConfig";

export const ANNOUNCEMENT_ACK_KEY = "announcement_ack_revision";

export function getAnnouncement(db: BetterSqlite3.Database) {
  const rows = db
    .prepare(
      "SELECT key, value FROM config WHERE key IN ('announcement_content', 'announcement_revision')",
    )
    .all() as { key: string; value: string }[];
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    content: config.announcement_content ?? "",
    revision: Number.parseInt(config.announcement_revision ?? "0", 10) || 0,
  };
}

export function updateAnnouncement(
  db: BetterSqlite3.Database,
  content: string,
) {
  return db.transaction(() => {
    const { revision } = getAnnouncement(db);
    const next = revision + 1;
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('announcement_content', ?)",
    ).run(content);
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('announcement_revision', ?)",
    ).run(String(next));
    return { content, revision: next };
  })();
}

export function acknowledgeAnnouncement(
  db: BetterSqlite3.Database,
  userId: string,
  revision: number,
): boolean {
  const current = getAnnouncement(db).revision;
  if (revision !== current) return false;
  upsertUserConfigValue(db, userId, ANNOUNCEMENT_ACK_KEY, String(revision));
  return true;
}

export function isAnnouncementAcknowledged(
  db: BetterSqlite3.Database,
  userId: string,
  revision: number,
): boolean {
  return (
    getUserConfigValue(db, userId, ANNOUNCEMENT_ACK_KEY) === String(revision)
  );
}
