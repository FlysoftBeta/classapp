import type BetterSqlite3 from "better-sqlite3";
import {
  findTeachDocument,
  listTeachDocuments,
} from "@/server/data/teachDocuments";
import {
  TEACH_DOCUMENTS_QUOTA_GROUP,
  type TeachDocumentsRuntime,
} from "@/server/runtime/teachDocumentsRuntime";
import { BlobStore, type BlobRead } from "@/server/storage/blobStore";
import { QuotaService } from "@/server/storage/quotaService";
import { PublicError } from "@/server/services/incidentService";

export interface TeachDocumentDownload {
  document: { id: string; name: string; file_size: number };
  stream: BlobRead;
}

/**
 * Request-bound view of teaching documents: admin listing, download, and
 * destructive cleanup. Process-lifetime capture/monitor and quota ownership
 * live in `TeachDocumentsRuntime`.
 */
export class TeachDocumentsService {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly blobs: BlobStore,
    private readonly runtime: TeachDocumentsRuntime,
  ) {}

  list() {
    return listTeachDocuments(this.db);
  }

  monitorAvailable() {
    return this.runtime.monitorAvailable;
  }

  async download(id: string): Promise<TeachDocumentDownload> {
    const document = findTeachDocument(this.db, id);
    if (!document) throw new PublicError("文档不存在");
    new QuotaService(this.db).touch(TEACH_DOCUMENTS_QUOTA_GROUP, document.id, 1);
    return {
      document: {
        id: document.id,
        name: document.name,
        file_size: document.file_size,
      },
      stream: await this.blobs.open(document.blob_id),
    };
  }

  async cleanupAll(): Promise<number> {
    let removed = 0;
    for (const document of listTeachDocuments(this.db)) {
      if (await this.runtime.evict(document.id)) removed += 1;
    }
    return removed;
  }
}

export function createTeachDocumentsService(
  db: BetterSqlite3.Database,
  blobs: BlobStore,
  runtime: TeachDocumentsRuntime,
): TeachDocumentsService {
  return new TeachDocumentsService(db, blobs, runtime);
}
