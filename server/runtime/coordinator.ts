import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "better-sqlite3";
import { Scope, withScope, type RequestIdentity } from "@/server/runtime/scope";
import { AiExecutionRuntime } from "@/server/runtime/aiExecutionRuntime";
import { ArticleImportRuntime } from "@/server/runtime/articleImportRuntime";
import {
  bindCoordinatorEventBus,
  EventBusRuntime,
  type BusEvent,
} from "@/server/runtime/eventBus";
import { MediaRuntime } from "@/server/runtime/mediaRuntime";
import { TeachDocumentsRuntime } from "@/server/runtime/teachDocumentsRuntime";
import { ArticleUploadRuntime } from "@/server/runtime/articleUploadRuntime";
import { StorageRuntime } from "@/server/storage/storageRuntime";
import { runtimeConfig } from "@/server/infra/runtimeConfig";
import { BUILD_ID } from "@/server/infra/env";
import { UpdateRuntime } from "@/server/runtime/update/runtime";
import { createLiveStickyHost } from "@/server/runtime/liveSticky";
import { ExecutorPool } from "@/server/runtime/executorPool";
import type {
  ExecutorJobBody,
  ExecutorJobResult,
} from "@/server/runtime/executorIpc";
import type { StickyCommand } from "@/server/runtime/sticky";
import {
  createAiService,
  type AiService,
} from "@/server/services/ai/aiService";
import { createAiBillingService } from "@/server/services/ai/aiBillingService";
import { randomUUID } from "node:crypto";

const coordinatorStorage = new AsyncLocalStorage<Coordinator>();

export function currentCoordinator(): Coordinator {
  const coordinator = coordinatorStorage.getStore();
  if (!coordinator) throw new Error("Coordinator is unavailable");
  return coordinator;
}
export class Coordinator {
  readonly aiExecution: AiExecutionRuntime;
  readonly articleImports: ArticleImportRuntime;
  readonly articleUploads: ArticleUploadRuntime;
  readonly events: EventBusRuntime;
  readonly media: MediaRuntime;
  readonly storage: StorageRuntime;
  readonly teachDocuments: TeachDocumentsRuntime;
  private readonly aiRunner: AiService;
  private readonly pool: ExecutorPool;
  private readonly liveSticky;
  private readonly updateRuntime: UpdateRuntime | null;

  constructor(
    readonly db: Database,
    readonly buildId = BUILD_ID,
  ) {
    this.aiExecution = new AiExecutionRuntime(db);
    const config = runtimeConfig();
    this.storage = new StorageRuntime(db, config.dataRoot);
    this.articleImports = new ArticleImportRuntime(db, this.storage.blobs);
    this.articleUploads = new ArticleUploadRuntime(db, this.storage.blobs);
    this.events = new EventBusRuntime(db, buildId);
    bindCoordinatorEventBus(this.events);
    this.media = new MediaRuntime(
      db,
      config.platform.media ?? {
        ytDlpPath: null,
        potServerEntry: null,
        pluginDirs: [],
      },
      this.storage.blobs,
    );
    this.storage.registerEvictor("media", this.media.quotaPolicy(), (item) =>
      this.media.evictTrack(item.itemId, item),
    );
    this.teachDocuments = new TeachDocumentsRuntime(db, this.storage.blobs);
    this.storage.registerEvictor(
      "teach-documents",
      this.teachDocuments.quotaPolicy(),
      (item) => this.teachDocuments.evict(item.itemId, item),
    );
    this.updateRuntime = config.update
      ? new UpdateRuntime(db, config.update)
      : null;
    this.updateRuntime?.start();
    if (this.updateRuntime) {
      console.log("[UpdateRuntime] 已启用");
    } else if (config.nodeEnv === "production") {
      console.warn(
        "[UpdateRuntime] 生产 boot 配置缺少 update，在线更新保持禁用",
      );
    }
    this.liveSticky = createLiveStickyHost({
      media: this.media,
      articleImports: this.articleImports,
      teachDocuments: this.teachDocuments,
      aiExecution: this.aiExecution,
      update: this.updateRuntime,
      queueCommand: (command) => this.applyCommand(command),
    });
    this.aiRunner = createAiService(
      db,
      this.aiExecution,
      createAiBillingService(db),
      this.storage.blobs,
      (input) => void this.aiRunner.execute(input),
    );
    this.pool = new ExecutorPool(
      config,
      this.liveSticky,
      this.media.available,
      this.teachDocuments.monitorAvailable,
    );
  }

  /** HTTP and other Coordinator-thread work. Streaming leases stay here. */
  scope(identity: RequestIdentity): Scope {
    const commands: StickyCommand[] = [];
    const sticky = createLiveStickyHost({
      media: this.media,
      articleImports: this.articleImports,
      teachDocuments: this.teachDocuments,
      aiExecution: this.aiExecution,
      update: this.updateRuntime,
      queueCommand: (command) => commands.push(command),
    });
    return new Scope(
      { db: this.db, blobs: this.storage.blobs, sticky, commands },
      identity,
    );
  }

  async withHttpScope<T>(
    identity: RequestIdentity,
    operation: (scope: Scope) => Promise<T>,
  ): Promise<T> {
    const scope = this.scope(identity);
    try {
      return await coordinatorStorage.run(this, () =>
        withScope(scope, () => operation(scope)),
      );
    } finally {
      this.applyCommands(scope.commands);
    }
  }

  async execute(job: ExecutorJobBody): Promise<ExecutorJobResult> {
    const result = await this.pool.submit({ ...job, id: randomUUID() });
    this.deliverEvents(result.events);
    this.applyCommands(result.commands);
    return result;
  }

  async closePool(): Promise<void> {
    this.updateRuntime?.stop();
    await this.pool.close();
    bindCoordinatorEventBus(null);
  }

  private deliverEvents(events: BusEvent[]): void {
    for (const event of events) this.events.deliver(event);
  }

  private applyCommands(commands: StickyCommand[]): void {
    for (const command of commands) this.applyCommand(command);
  }

  private applyCommand(command: StickyCommand): void {
    if (command.type === "ai.execute") {
      void this.aiRunner.execute(command.input);
      return;
    }
    void this.media
      .ensureMaterialized(command.track, command.kind)
      .catch(() => undefined);
  }
}
