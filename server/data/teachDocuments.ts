import type BetterSqlite3 from "better-sqlite3";

export type TeachDocumentType = "word" | "powerpoint" | "excel";

export interface TeachDocument {
  id: string;
  application: string;
  document_type: TeachDocumentType;
  name: string;
  blob_path: string;
  file_size: number;
  created_at: string;
}

export function insertTeachDocument(
  db: BetterSqlite3.Database,
  document: Omit<TeachDocument, "created_at">,
): TeachDocument {
  db.prepare(
    `INSERT INTO teach_documents
       (id, application, document_type, name, blob_path, file_size)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    document.id,
    document.application,
    document.document_type,
    document.name,
    document.blob_path,
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
      `SELECT id, application, document_type, name, blob_path, file_size, created_at
       FROM teach_documents
       WHERE id = ?`,
    )
    .get(id) as TeachDocument | undefined;
}

export function listTeachDocuments(
  db: BetterSqlite3.Database,
): TeachDocument[] {
  return db
    .prepare(
      `SELECT id, application, document_type, name, blob_path, file_size, created_at
       FROM teach_documents
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all() as TeachDocument[];
}

export function listExpiredTeachDocuments(
  db: BetterSqlite3.Database,
  retentionDays: number,
): TeachDocument[] {
  return db
    .prepare(
      `SELECT id, application, document_type, name, blob_path, file_size, created_at
       FROM teach_documents
       WHERE created_at <= datetime('now', ?)`,
    )
    .all(`-${retentionDays} days`) as TeachDocument[];
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
