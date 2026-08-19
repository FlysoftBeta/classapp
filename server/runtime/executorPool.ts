import { Worker } from "node:worker_threads";
import os from "node:os";
import type { RuntimeConfig } from "@/server/infra/runtimeConfig";
import type {
  ExecutorJob,
  ExecutorJobResult,
  ExecutorWorkerData,
  ParentMessage,
  StickyRpcMethod,
  WorkerMessage,
} from "@/server/runtime/executorIpc";
import type { StickyHost } from "@/server/runtime/sticky";
import { ResultTools } from "@/shared/protocol/result";

function executorWorkerUrl(): URL {
  const here = import.meta.url;
  if (here.endsWith("/main.mjs") || here.endsWith("\\main.mjs")) {
    return new URL("./executor.mjs", here);
  }
  return new URL("./executorWorker.dev.mjs", here);
}

/**
 * Worker threads inherit `process.execArgv` unless replaced. `node --test`
 * and `tsx watch` must not leak: the former turns the worker into a test
 * runner, the latter watches the worker entry forever.
 */
export function filterExecutorExecArgv(execArgv: readonly string[]): string[] {
  return execArgv.filter(
    (arg) =>
      arg !== "--watch" &&
      !arg.startsWith("--watch=") &&
      arg !== "--test" &&
      !arg.startsWith("--test-"),
  );
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
  private failed: Error | null = null;
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
      this.fail(error);
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        this.fail(new Error(`Executor worker exited with code ${code}`));
      }
    });
  }

  submit(job: ExecutorJob): Promise<ExecutorJobResult> {
    return new Promise((resolve, reject) => {
      const run = () => {
        if (this.failed) {
          reject(this.failed);
          return;
        }
        this.busy = true;
        this.pending.set(job.id, { resolve, reject });
        this.post({ type: "job", job });
      };
      if (this.failed) {
        reject(this.failed);
        return;
      }
      if (this.busy) this.queue.push(run);
      else run();
    });
  }

  get idle(): boolean {
    return !this.busy && !this.failed;
  }

  shutdown(): void {
    this.post({ type: "shutdown" });
  }

  private fail(error: Error): void {
    if (!this.failed) {
      this.failed = error;
      console.error("[ExecutorPool] worker failed", error);
    }
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
    this.busy = false;
    const queued = this.queue.splice(0);
    for (const run of queued) run();
  }

  private post(message: ParentMessage): void {
    this.worker.postMessage(message);
  }

  private async onMessage(message: WorkerMessage): Promise<void> {
    if (message.type === "ready") return;
    if (message.type === "rpc") {
      try {
        const value = await this.dispatchRpc(message.method, message.args);
        this.post({ type: "rpc-result", rpcId: message.rpcId, ok: true, value });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.post({
          type: "rpc-result",
          rpcId: message.rpcId,
          ok: false,
          error: { message: err.message, name: err.name },
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
  private readonly buildId: string;

  constructor(
    config: RuntimeConfig,
    sticky: StickyHost,
    mediaAvailable: boolean,
    teachMonitorAvailable: boolean,
  ) {
    this.buildId = config.buildId;
    const workerData: ExecutorWorkerData = {
      config,
      mediaAvailable,
      teachMonitorAvailable,
    };
    const url = executorWorkerUrl();
    const count = executorWorkerCount();
    const execArgv = filterExecutorExecArgv(process.execArgv);
    for (let i = 0; i < count; i += 1) {
      const worker = new Worker(url, {
        workerData,
        execArgv,
      });
      this.slots.push(new ExecutorWorkerSlot(worker, sticky));
    }
  }

  async submit(job: ExecutorJob): Promise<ExecutorJobResult> {
    const idle = this.slots.find((slot) => slot.idle);
    const slot = idle ?? this.slots[this.cursor % this.slots.length]!;
    this.cursor += 1;
    try {
      return await slot.submit(job);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        id: job.id,
        events: [],
        commands: [],
        outcome: ResultTools.err(
          { message: err.message, incidentId: "executor" },
          { buildId: this.buildId },
        ),
      };
    }
  }

  close(): void {
    for (const slot of this.slots) slot.shutdown();
  }
}
