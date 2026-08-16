import path from "node:path";
import type { Database } from "better-sqlite3";
import { Scope, type RequestIdentity } from "@/server/runtime/scope";
import { AiExecutionRuntime } from "@/server/runtime/aiExecutionRuntime";
import { ArticleImportRuntime } from "@/server/services/articleImportService";
import {
  bindEventBusRuntime,
  EventBusRuntime,
} from "@/server/services/eventBus";
import { MediaRuntime } from "@/server/runtime/mediaRuntime";
import { runtimeConfig } from "@/server/infra/runtimeConfig";
import { BUILD_ID } from "@/server/infra/env";

/** Process-bound mechanisms and resources. */
export class Runtime {
  readonly aiExecution: AiExecutionRuntime;
  readonly articleImports: ArticleImportRuntime;
  readonly events: EventBusRuntime;
  readonly media: MediaRuntime;

  constructor(
    readonly db: Database,
    readonly buildId = BUILD_ID,
  ) {
    this.aiExecution = new AiExecutionRuntime(db);
    this.articleImports = new ArticleImportRuntime(db);
    this.events = new EventBusRuntime(db, buildId);
    bindEventBusRuntime(this.events);
    const config = runtimeConfig();
    this.media = new MediaRuntime(
      db,
      config.platform.media ?? {
        ytDlpPath: null,
        potServerEntry: null,
        pluginDirs: [],
      },
      path.join(config.dataRoot, "objects", "media"),
    );
  }

  scope(identity: RequestIdentity): Scope {
    return new Scope(this, identity);
  }
}
