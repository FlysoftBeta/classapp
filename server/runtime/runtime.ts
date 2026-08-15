import type { Database } from "better-sqlite3";
import { Scope, type RequestIdentity } from "@/server/runtime/scope";
import { AiExecutionRuntime } from "@/server/runtime/aiExecutionRuntime";
import { ArticleImportRuntime } from "@/server/services/articleImportService";
import {
  bindEventBusRuntime,
  EventBusRuntime,
} from "@/server/services/eventBus";
import { BUILD_ID } from "@/server/infra/env";

/** Process-bound mechanisms and resources. */
export class Runtime {
  readonly aiExecution: AiExecutionRuntime;
  readonly articleImports: ArticleImportRuntime;
  readonly events: EventBusRuntime;

  constructor(
    readonly db: Database,
    readonly buildId = BUILD_ID,
  ) {
    this.aiExecution = new AiExecutionRuntime(db);
    this.articleImports = new ArticleImportRuntime(db);
    this.events = new EventBusRuntime(db, buildId);
    bindEventBusRuntime(this.events);
  }

  scope(identity: RequestIdentity): Scope {
    return new Scope(this, identity);
  }
}
