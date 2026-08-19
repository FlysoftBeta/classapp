import assert from "node:assert/strict";
import test from "node:test";
import { executorWorkerExecArgv } from "@/server/runtime/executorPool";

test("Executor workers keep tsx loader flags and drop the test runner", () => {
  assert.deepEqual(
    executorWorkerExecArgv([
      "--import",
      "tsx",
      "--test",
      "--test-timeout=180000",
      "--test-concurrency=1",
      "--test-reporter",
      "spec",
    ]),
    ["--import", "tsx"],
  );
});

test("Executor workers still drop watch flags used by the development server", () => {
  assert.deepEqual(
    executorWorkerExecArgv(["--import", "tsx", "--watch", "--watch=client"]),
    ["--import", "tsx"],
  );
});
