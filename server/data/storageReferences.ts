import type { Database } from "better-sqlite3";

/**
 * Authoritative live object keys per storage namespace. These collectors are
 * used by ObjectStore.reconcileOrphans; anything on disk that is not named by
 * one of these rows is compensation-eligible garbage.
 */

export function liveMediaObjectKeys(db: Database): string[] {
  return (
    db
      .prepare(
        `SELECT object_path FROM media_assets
          WHERE state = 'ready' AND object_path IS NOT NULL`,
      )
      .all() as Array<{ object_path: string }>
  ).map((row) => row.object_path);
}

export function liveTeachDocumentObjectKeys(db: Database): string[] {
  return (
    db.prepare("SELECT object_key FROM teach_documents").all() as Array<{
      object_key: string;
    }>
  ).map((row) => row.object_key);
}

export function liveArticleBundleObjectKeys(db: Database): string[] {
  const keys: string[] = [];
  const articles = db
    .prepare(
      `SELECT provider_json FROM articles
        WHERE json_extract(provider_json, '$.type') = 'bundle'`,
    )
    .all() as Array<{ provider_json: string }>;
  for (const row of articles) {
    try {
      const provider = JSON.parse(row.provider_json) as {
        source_file?: string;
        archive_file?: string;
      };
      if (provider.source_file) keys.push(provider.source_file);
      if (provider.archive_file) keys.push(provider.archive_file);
    } catch {
      // Invalid provider JSON is rejected at insert; keep the collector total.
    }
  }
  const uploads = db
    .prepare(
      `SELECT source_key, archive_key FROM article_uploads
        WHERE status IN ('staging', 'published')`,
    )
    .all() as Array<{ source_key: string; archive_key: string }>;
  for (const upload of uploads) {
    keys.push(upload.source_key, upload.archive_key);
  }
  return keys;
}

export function liveAiWorkspaceObjectKeys(db: Database): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT user_id FROM (
           SELECT user_id FROM ai_conversations
           UNION
           SELECT user_id FROM ai_file_operations
         )`,
      )
      .all() as Array<{ user_id: string }>
  ).map((row) => row.user_id);
}
