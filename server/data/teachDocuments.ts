import type BetterSqlite3 from "better-sqlite3";

export type TeachDocumentType = "word" | "powerpoint" | "excel";
export type TeachDocumentStatus = "capturing" | "ready";

export interface TeachDocument {
  id: string;
  application: string;
  document_type: TeachDocumentType;
  name: string;
  object_key: string;
  file_size: number;
  status: TeachDocumentStatus;
  created_at: string;
}

const TEACH_DOCUMENT_SELECT = `
  SELECT id, application, document_type, name, object_key, file_size,
         status, created_at
    FROM teach_documents`;

export function insertTeachDocument(
  db: BetterSqlite3.Database,
  document: Omit<TeachDocument, "created_at">,
): TeachDocument {
  db.prepare(
    `INSERT INTO teach_documents
       (id, application, document_type, name, object_key, file_size, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    document.id,
    document.application,
    document.document_type,
    document.name,
    document.object_key,
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

export function findTeachDocumentByObjectKey(
  db: BetterSqlite3.Database,
  objectKey: string,
): TeachDocument | undefined {
  return db
    .prepare(
      `${TEACH_DOCUMENT_SELECT} WHERE object_key = ? AND status = 'ready'`,
    )
    .get(objectKey) as TeachDocument | undefined;
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

/** Capturing rows whose copy was interrupted; compensation trashes objects. */
export function listCapturingTeachDocuments(
  db: BetterSqlite3.Database,
): TeachDocument[] {
  return db
    .prepare(`${TEACH_DOCUMENT_SELECT} WHERE status = 'capturing'`)
    .all() as TeachDocument[];
}

/**
 * Seed/refresh teaching-document quota rows directly in SQL; the capture
 * catalog may be large enough that Node-side iteration is unacceptable.
 */
export function reconcileTeachDocumentQuotaItems(
  db: BetterSqlite3.Database,
): void {
  db.prepare(
    `INSERT INTO storage_quota_items
       (group_name, item_key, bytes, touch_time_ms, touch_freq, created_at_ms)
     SELECT 'teach-documents', id, file_size,
            CAST(strftime('%s', created_at) AS INTEGER) * 1000,
            0,
            CAST(strftime('%s', created_at) AS INTEGER) * 1000
       FROM teach_documents
      WHERE status = 'ready'
     ON CONFLICT(group_name, item_key) DO UPDATE SET
       bytes = excluded.bytes,
       touch_time_ms = excluded.touch_time_ms,
       touch_freq = (storage_quota_items.touch_freq +
         (excluded.touch_time_ms - storage_quota_items.touch_time_ms)) / 2.0`,
  ).run();
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
