/**
 * Development/test executor entry. Worker threads do not apply the parent
 * process `--import tsx` hook, and inheriting `node --test` execArgv would
 * turn the worker into a test runner. This plain ESM file loads the
 * TypeScript worker with tsx's scoped importer.
 */
import { tsImport } from "tsx/esm/api";

await tsImport("./executorWorker.ts", import.meta.url);
