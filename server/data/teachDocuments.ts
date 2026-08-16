import type BetterSqlite3 from "better-sqlite3";

export type TeachDocumentType = "word" | "powerpoint" | "excel";

export interface TeachDocument {
  id: string;
  application: string;
  document_type: TeachDocumentType;
  name: string;
  object_key: string;
  file_size: number;
  created_at: string;
}

export function insertTeachDocument(
  db: BetterSqlite3.Database,
  document: Omit<TeachDocument, "created_at">,
): TeachDocument {
  db.prepare(
    `INSERT INTO teach_documents
       (id, application, document_type, name, object_key, file_size)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    document.id,
    document.application,
    document.document_type,
    document.name,
    document.object_key,
    document.file_size,
  );
  return findTeachDocument(db, document.id)!;
}

export function findTeachDocument(
  db: BetterSqlite3.Database,
  id: string,
): TeachDocument | undefined {
  return db
    .prepare(
      `SELECT id, application, document_type, name, object_key, file_size, created_at
       FROM teach_documents
       WHERE id = ?`,
    )
    .get(id) as TeachDocument | undefined;
}

export function findTeachDocumentByObjectKey(
  db: BetterSqlite3.Database,
  objectKey: string,
): TeachDocument | undefined {
  return db
    .prepare(
      `SELECT id, application, document_type, name, object_key, file_size, created_at
       FROM teach_documents
       WHERE object_key = ?`,
    )
    .get(objectKey) as TeachDocument | undefined;
}

export function listTeachDocuments(
  db: BetterSqlite3.Database,
): TeachDocument[] {
  return db
    .prepare(
      `SELECT id, application, document_type, name, object_key, file_size, created_at
       FROM teach_documents
       ORDER BY created_at DESC, rowid DESC`,
    )
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
      WHERE true
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
