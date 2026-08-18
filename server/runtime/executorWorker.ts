import { parentPort, workerData } from "node:worker_threads";
import {
  setRuntimeConfig,
  type RuntimeConfig,
} from "@/server/infra/runtimeConfig";
import type { ExecutorWorkerData } from "@/server/runtime/executorIpc";

if (!parentPort) {
  throw new Error("Executor worker must run as a worker_thread");
}

const payload = workerData as ExecutorWorkerData;
setRuntimeConfig(payload.config as RuntimeConfig);
await import("./executorWorkerMain");
