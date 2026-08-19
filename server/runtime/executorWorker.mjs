import { parentPort } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

/**
 * Node cannot load a `.ts` Worker entry even with `--import tsx`. This
 * JavaScript bootstrap is the development Worker URL; it then loads the
 * TypeScript worker through tsx's programmatic importer. Production uses
 * compiled `executor.mjs`.
 */
if (!parentPort) {
  throw new Error("Executor worker must run as a worker_thread");
}

await tsImport("./executorWorker.ts", import.meta.url);
