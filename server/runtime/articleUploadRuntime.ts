import type { Database } from "better-sqlite3";
import {
  abandonArticleUpload,
  listStaleArticleUploads,
} from "@/server/data/articleUploads";
import { ObjectStore } from "@/server/storage/objectStore";
import { objectRef } from "@/server/storage/paths";
import { BUILD_ID } from "@/server/infra/env";
import { recordContainedServerIncident } from "@/server/services/incidentService";

const STAGING_TTL_MINUTES = 30;

/**
 * Startup/maintenance compensation for multipart article uploads. The upload
 * row is authoritative; stale staging rows are abandoned and their already
 * committed objects are reclaimed through the normal trash path.
 */
export class ArticleUploadRuntime {
  constructor(
    private readonly db: Database,
    private readonly objects: ObjectStore,
  ) {}

  async reconcile(): Promise<number> {
    const olderThan = new Date(Date.now() - STAGING_TTL_MINUTES * 60_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    const stale = listStaleArticleUploads(this.db, olderThan);
    let reclaimed = 0;
    for (const upload of stale) {
      try {
        for (const key of [upload.source_key, upload.archive_key]) {
          await this.objects.trash(objectRef("article-bundles", key));
        }
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
