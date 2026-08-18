import type { Database } from "better-sqlite3";

export interface AiWorkspaceRow {
  user_id: string;
  blob_id: string | null;
  staging_blob_id: string | null;
}

export function findAiWorkspace(
  db: Database,
  userId: string,
): AiWorkspaceRow | null {
  return (
    (db
      .prepare(
        `SELECT user_id, blob_id, staging_blob_id
           FROM ai_workspaces WHERE user_id = ?`,
      )
      .get(userId) as AiWorkspaceRow | undefined) ?? null
  );
}

export function beginAiWorkspaceStaging(
  db: Database,
  userId: string,
  stagingBlobId: string,
): void {
  db.prepare(
    `INSERT INTO ai_workspaces (user_id, blob_id, staging_blob_id, updated_at)
     VALUES (?, NULL, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       staging_blob_id = excluded.staging_blob_id,
       updated_at = datetime('now')`,
  ).run(userId, stagingBlobId);
}

export function publishAiWorkspace(
  db: Database,
  userId: string,
  blobId: string,
): string | null {
  const previous = findAiWorkspace(db, userId);
  db.prepare(
    `UPDATE ai_workspaces
        SET blob_id = ?, staging_blob_id = NULL, updated_at = datetime('now')
      WHERE user_id = ? AND staging_blob_id = ?`,
  ).run(blobId, userId, blobId);
  return previous?.blob_id ?? null;
}

export function deleteAiWorkspace(db: Database, userId: string): AiWorkspaceRow | null {
  const previous = findAiWorkspace(db, userId);
  db.prepare("DELETE FROM ai_workspaces WHERE user_id = ?").run(userId);
  return previous;
}

/** Interrupted replaces: drop the staging blob and keep the last ready blob. */
export function listStaleAiWorkspaceStaging(db: Database): AiWorkspaceRow[] {
  return db
    .prepare(
      `SELECT user_id, blob_id, staging_blob_id
         FROM ai_workspaces WHERE staging_blob_id IS NOT NULL`,
    )
    .all() as AiWorkspaceRow[];
}

export function clearAiWorkspaceStaging(db: Database, userId: string): void {
  db.prepare(
    `UPDATE ai_workspaces SET staging_blob_id = NULL, updated_at = datetime('now')
      WHERE user_id = ?`,
  ).run(userId);
}
