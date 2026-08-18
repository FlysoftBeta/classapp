import type BetterSqlite3 from "better-sqlite3";

export type TeachDocumentType = "word" | "powerpoint" | "excel";
export type TeachDocumentStatus = "capturing" | "ready";

export interface TeachDocument {
  id: string;
  application: string;
  document_type: TeachDocumentType;
  name: string;
  blob_id: string;
  file_size: number;
  status: TeachDocumentStatus;
  created_at: string;
}

const TEACH_DOCUMENT_SELECT = `
  SELECT id, application, document_type, name, blob_id, file_size,
         status, created_at
    FROM teach_documents`;

export function insertTeachDocument(
  db: BetterSqlite3.Database,
  document: Omit<TeachDocument, "created_at">,
): TeachDocument {
  db.prepare(
    `INSERT INTO teach_documents
       (id, application, document_type, name, blob_id, file_size, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    document.id,
    document.application,
    document.document_type,
    document.name,
    document.blob_id,
    document.file_size,
    document.status,
  );
  return findTeachDocument(db, document.id)!;
}

export function publishTeachDocument(
  db: BetterSqlite3.Database,
  id: string,
  fileSize: number,
): TeachDocument {
  db.prepare(
    `UPDATE teach_documents SET file_size = ?, status = 'ready'
      WHERE id = ? AND status = 'capturing'`,
  ).run(fileSize, id);
  return findTeachDocument(db, id)!;
}

export function findTeachDocument(
  db: BetterSqlite3.Database,
  id: string,
): TeachDocument | undefined {
  return db
    .prepare(`${TEACH_DOCUMENT_SELECT} WHERE id = ? AND status = 'ready'`)
    .get(id) as TeachDocument | undefined;
}

export function findTeachDocumentById(
  db: BetterSqlite3.Database,
  id: string,
): TeachDocument | undefined {
  return db
    .prepare(`${TEACH_DOCUMENT_SELECT} WHERE id = ?`)
    .get(id) as TeachDocument | undefined;
}

export function listTeachDocuments(
  db: BetterSqlite3.Database,
): TeachDocument[] {
  return db
    .prepare(
      `${TEACH_DOCUMENT_SELECT} WHERE status = 'ready'
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all() as TeachDocument[];
}

/** Capturing rows whose copy was interrupted; compensation drops blobs. */
export function listCapturingTeachDocuments(
  db: BetterSqlite3.Database,
): TeachDocument[] {
  return db
    .prepare(`${TEACH_DOCUMENT_SELECT} WHERE status = 'capturing'`)
    .all() as TeachDocument[];
}

/**
 * Seed/refresh teaching-document cache weights. Heat and touched_at stay.
 */
export function reconcileTeachDocumentQuotaItems(
  db: BetterSqlite3.Database,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO storage_quota_items
       (pool, item_id, class, weight, heat, touched_at_ms, pin_until_ms, created_at_ms)
     SELECT 'teach-documents', id, 'cache', file_size, 1, ?, 0, ?
       FROM teach_documents
      WHERE status = 'ready'
     ON CONFLICT(pool, item_id) DO UPDATE SET
       weight = excluded.weight`,
  ).run(now, now);
}

export function deleteTeachDocuments(
  db: BetterSqlite3.Database,
  ids: string[],
): number {
  if (ids.length === 0) return 0;
  const remove = db.prepare("DELETE FROM teach_documents WHERE id = ?");
  return db.transaction((documentIds: string[]) => {
    let deleted = 0;
    for (const id of documentIds) {
      deleted += remove.run(id).changes;
    }
    return deleted;
  })(ids);
}
