import { Worker } from "node:worker_threads";
import os from "node:os";
import type { RuntimeConfig } from "@/server/infra/runtimeConfig";
import {
  serializeStickyError,
  type ExecutorJob,
  type ExecutorJobResult,
  type ExecutorWorkerData,
  type ParentMessage,
  type StickyRpcMethod,
  type WorkerMessage,
} from "@/server/runtime/executorIpc";
import type { StickyHost } from "@/server/runtime/sticky";

function executorWorkerUrl(): URL {
  const here = import.meta.url;
  if (here.endsWith("/main.mjs") || here.endsWith("\\main.mjs")) {
    return new URL("./executor.mjs", here);
  }
  return new URL("./executorWorker.ts", here);
}

const RPC_TIMEOUT_MS = 120_000;

export function executorWorkerCount(): number {
  const env = Number.parseInt(process.env.CLASSAPP_EXECUTORS ?? "", 10);
  if (Number.isSafeInteger(env) && env > 0) return env;
  const cpus =
    typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length;
  return Math.max(2, Math.min(8, cpus));
}

interface PendingJob {
  resolve: (result: ExecutorJobResult) => void;
  reject: (error: Error) => void;
}

class ExecutorWorkerSlot {
  private busy = false;
  private readonly pending = new Map<string, PendingJob>();
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly worker: Worker,
    private readonly sticky: StickyHost,
  ) {
    worker.on("message", (message: WorkerMessage) => {
      void this.onMessage(message);
    });
    worker.on("error", (error: Error) => {
      for (const job of this.pending.values()) job.reject(error);
      this.pending.clear();
    });
  }

  submit(job: ExecutorJob): Promise<ExecutorJobResult> {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.busy = true;
        this.pending.set(job.id, { resolve, reject });
        this.post({ type: "job", job });
      };
      if (this.busy) this.queue.push(run);
      else run();
    });
  }

  get idle(): boolean {
    return !this.busy;
  }

  shutdown(): void {
    this.post({ type: "shutdown" });
  }

  private post(message: ParentMessage): void {
    this.worker.postMessage(message);
  }

  private async onMessage(message: WorkerMessage): Promise<void> {
    if (message.type === "ready") return;
    if (message.type === "rpc") {
      try {
        const value = await this.dispatchRpc(message.method, message.args);
        this.post({
          type: "rpc-result",
          rpcId: message.rpcId,
          ok: true,
          value,
        });
      } catch (error) {
        this.post({
          type: "rpc-result",
          rpcId: message.rpcId,
          ok: false,
          error: serializeStickyError(error),
        });
      }
      return;
    }
    if (message.type !== "done") return;
    const waiter = this.pending.get(message.result.id);
    this.pending.delete(message.result.id);
    this.busy = false;
    waiter?.resolve(message.result);
    const next = this.queue.shift();
    next?.();
  }

  private async dispatchRpc(
    method: StickyRpcMethod,
    args: unknown[],
  ): Promise<unknown> {
    const timeout = setTimeout(() => undefined, RPC_TIMEOUT_MS);
    timeout.unref();
    try {
      switch (method) {
        case "media.search":
          return await this.sticky.media.search(
            args[0] as string,
            args[1] as number,
          );
        case "articleImport.search":
          return await this.sticky.articleImports.search(
            args[0] as string,
            args[1] as string,
          );
        case "articleImport.start":
          return await this.sticky.articleImports.start(
            args[0] as never,
            args[1] as string,
            args[2] as string,
            args[3] as string,
          );
        case "articleImport.list":
          return await this.sticky.articleImports.list(args[0] as string);
        case "teach.evict":
          return await this.sticky.teachDocuments.evict(args[0] as string);
        case "ai.abort":
          this.sticky.ai.abort(args[0] as string);
          return undefined;
        case "ai.abortUser":
          this.sticky.ai.abortUser(args[0] as string);
          return undefined;
        case "update.status":
          return await this.sticky.update.status();
        case "update.cloudConfigChanged":
          this.sticky.update.cloudConfigChanged();
          return undefined;
        case "update.checkCloud":
          return await this.sticky.update.checkCloud();
        case "update.installCloud":
          await this.sticky.update.installCloud();
          return undefined;
        case "update.confirm":
          await this.sticky.update.confirm();
          return undefined;
        case "update.rollback":
          await this.sticky.update.rollback();
          return undefined;
        default:
          throw new Error(`Unknown sticky RPC ${method}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ExecutorPool {
  private readonly slots: ExecutorWorkerSlot[] = [];
  private cursor = 0;

  constructor(
    config: RuntimeConfig,
    sticky: StickyHost,
    mediaAvailable: boolean,
    teachMonitorAvailable: boolean,
  ) {
    const workerConfig = { ...config };
    delete workerConfig.update;
    const workerData: ExecutorWorkerData = {
      config: workerConfig,
      mediaAvailable,
      teachMonitorAvailable,
    };
    const url = executorWorkerUrl();
    const count = executorWorkerCount();
    for (let i = 0; i < count; i += 1) {
      const worker = new Worker(url, {
        workerData,
        execArgv: process.execArgv.filter(
          (arg) => arg !== "--watch" && !arg.startsWith("--watch="),
        ),
      });
      this.slots.push(new ExecutorWorkerSlot(worker, sticky));
    }
  }

  submit(job: ExecutorJob): Promise<ExecutorJobResult> {
    const idle = this.slots.find((slot) => slot.idle);
    const slot = idle ?? this.slots[this.cursor % this.slots.length]!;
    this.cursor += 1;
    return slot.submit(job);
  }

  close(): void {
    for (const slot of this.slots) slot.shutdown();
  }
}
