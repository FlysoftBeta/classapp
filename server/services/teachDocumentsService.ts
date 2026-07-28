import type BetterSqlite3 from "better-sqlite3";
import {
  deleteTeachDocuments,
  insertTeachDocument,
  listExpiredTeachDocuments,
  listTeachDocuments,
  type TeachDocumentType,
} from "@/server/data/teachDocuments";
import {
  copyTeachDocument,
  removeTeachDocumentBlob,
} from "@/server/infra/teachDocumentBlobs";

export interface OpenOfficeDocument {
  application: string;
  documentType: TeachDocumentType;
  name: string;
  path: string;
}

const RETENTION_DAYS = 7;

export class TeachDocumentsService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list() {
    return listTeachDocuments(this.db);
  }

  async capture(document: OpenOfficeDocument): Promise<void> {
    const stored = await copyTeachDocument(document.path);
    try {
      insertTeachDocument(this.db, {
        id: stored.id,
        application: document.application,
        document_type: document.documentType,
        name: document.name,
        blob_path: stored.relativePath,
        file_size: stored.fileSize,
      });
    } catch (error) {
      await removeTeachDocumentBlob(stored.relativePath);
      throw error;
    }
  }

  async cleanupExpired(): Promise<number> {
    return this.remove(listExpiredTeachDocuments(this.db, RETENTION_DAYS));
  }

  async cleanupAll(): Promise<number> {
    return this.remove(listTeachDocuments(this.db));
  }

  private async remove(
    documents: Array<{ id: string; blob_path: string }>,
  ): Promise<number> {
    const removedIds: string[] = [];
    for (const document of documents) {
      try {
        await removeTeachDocumentBlob(document.blob_path);
        removedIds.push(document.id);
      } catch (error) {
        console.error(
          `[TeachDocuments] 无法删除 blob ${document.blob_path}`,
          error,
        );
      }
    }
    return deleteTeachDocuments(this.db, removedIds);
  }
}

export function createTeachDocumentsService(
  db: BetterSqlite3.Database,
): TeachDocumentsService {
  return new TeachDocumentsService(db);
}
