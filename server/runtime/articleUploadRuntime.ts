import type { Database } from "better-sqlite3";
import {
  abandonArticleUpload,
  listStaleArticleUploads,
} from "@/server/data/articleUploads";
import { BlobStore } from "@/server/storage/blobStore";
import { QuotaService } from "@/server/storage/quotaService";
import {
  ARTICLE_ARCHIVE_POOL,
  ARTICLE_SOURCE_POOL,
} from "@/server/services/articlesService";
import { BUILD_ID } from "@/server/infra/env";
import { recordContainedServerIncident } from "@/server/services/incidentService";

const STAGING_TTL_MINUTES = 30;

/**
 * Startup/maintenance compensation for multipart article uploads. The upload
 * row is authoritative; stale staging rows are abandoned and their already
 * committed blobs are dropped.
 */
export class ArticleUploadRuntime {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
  ) {}

  async reconcile(): Promise<number> {
    const olderThan = new Date(Date.now() - STAGING_TTL_MINUTES * 60_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    const stale = listStaleArticleUploads(this.db, olderThan);
    const quota = new QuotaService(this.db);
    let reclaimed = 0;
    for (const upload of stale) {
      try {
        for (const blobId of [upload.source_blob_id, upload.archive_blob_id]) {
          await this.blobs.drop(blobId);
        }
        quota.release(ARTICLE_SOURCE_POOL, upload.source_blob_id);
        quota.release(ARTICLE_ARCHIVE_POOL, upload.archive_blob_id);
        abandonArticleUpload(this.db, upload.id);
        reclaimed += 1;
      } catch (error) {
        recordContainedServerIncident(this.db, BUILD_ID, error, {
          component: "article-upload",
          phase: "reconcile-stale-upload",
          upload_id: upload.id,
        });
      }
    }
    return reclaimed;
  }
}
