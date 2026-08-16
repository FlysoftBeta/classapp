import type { Database } from "better-sqlite3";
import { Scope, type RequestIdentity } from "@/server/runtime/scope";
import { AiExecutionRuntime } from "@/server/runtime/aiExecutionRuntime";
import { ArticleImportRuntime } from "@/server/services/articleImportService";
import {
  bindEventBusRuntime,
  EventBusRuntime,
} from "@/server/services/eventBus";
import { MediaRuntime } from "@/server/runtime/mediaRuntime";
import { TeachDocumentsRuntime } from "@/server/runtime/teachDocumentsRuntime";
import { ArticleUploadRuntime } from "@/server/runtime/articleUploadRuntime";
import { StorageRuntime } from "@/server/storage/storageRuntime";
import { runtimeConfig } from "@/server/infra/runtimeConfig";
import { BUILD_ID } from "@/server/infra/env";

/** Process-bound mechanisms and resources. */
export class Runtime {
  readonly aiExecution: AiExecutionRuntime;
  readonly articleImports: ArticleImportRuntime;
  readonly articleUploads: ArticleUploadRuntime;
  readonly events: EventBusRuntime;
  readonly media: MediaRuntime;
  readonly storage: StorageRuntime;
  readonly teachDocuments: TeachDocumentsRuntime;

  constructor(
    readonly db: Database,
    readonly buildId = BUILD_ID,
  ) {
    this.aiExecution = new AiExecutionRuntime(db);
    const config = runtimeConfig();
    this.storage = new StorageRuntime(db, config.dataRoot);
    this.articleImports = new ArticleImportRuntime(db, this.storage.objects);
    this.articleUploads = new ArticleUploadRuntime(db, this.storage.objects);
    this.events = new EventBusRuntime(db, buildId);
    bindEventBusRuntime(this.events);
    this.media = new MediaRuntime(
      db,
      config.platform.media ?? {
        ytDlpPath: null,
        potServerEntry: null,
        pluginDirs: [],
      },
      this.storage.objects,
    );
    this.storage.registerEvictor("media", this.media.quotaPolicy(), (item) =>
      this.media.evictTrack(item.itemKey),
    );
    this.teachDocuments = new TeachDocumentsRuntime(db, this.storage.objects);
    this.storage.registerEvictor(
      "teach-documents",
      this.teachDocuments.quotaPolicy(),
      (item) => this.teachDocuments.evict(item.itemKey),
    );
  }

  scope(identity: RequestIdentity): Scope {
    return new Scope(this, identity);
  }
}
