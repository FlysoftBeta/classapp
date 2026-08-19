import assert from "node:assert/strict";
import test from "node:test";
import { filterExecutorExecArgv } from "@/server/runtime/executorPool";

test("filterExecutorExecArgv drops test and watch flags but keeps tsx", () => {
  assert.deepEqual(
    filterExecutorExecArgv([
      "--import",
      "tsx",
      "--test",
      "--test-reporter=spec",
      "--test-timeout=120000",
      "--test-concurrency=1",
      "--watch",
      "--watch=server",
    ]),
    ["--import", "tsx"],
  );
});

test("filterExecutorExecArgv leaves production argv unchanged", () => {
  assert.deepEqual(filterExecutorExecArgv([]), []);
  assert.deepEqual(filterExecutorExecArgv(["--enable-source-maps"]), [
    "--enable-source-maps",
  ]);
});
