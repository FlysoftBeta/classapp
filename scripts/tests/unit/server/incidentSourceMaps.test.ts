import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileIncidentSourceMaps } from "@/server/infra/incidentSourceMaps";

test("source maps symbolize current-build stacks and leave other builds untouched", () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "classapp-source-map-"));
  const directory = path.join(appDir, "server", "source-maps");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      format: "classapp-source-maps-v1",
      buildId: "build-1",
      maps: {
        client: "client.map",
        server: ["server-main.mjs.map", "server-executor.mjs.map"],
      },
    }),
  );
  const map = JSON.stringify({
    version: 3,
    file: "app.js",
    sources: ["client/interact/example.ts"],
    names: ["runExample"],
    mappings: "AAAAA",
  });
  const serverMap = JSON.stringify({
    version: 3,
    file: "main.mjs",
    sources: ["server/runtime/coordinator.ts"],
    names: ["runCoordinator"],
    mappings: "AAAAA",
  });
  const executorMap = JSON.stringify({
    version: 3,
    file: "executor.mjs",
    sources: ["server/runtime/executorWorkerMain.ts"],
    names: ["runJob"],
    mappings: "AAAAA",
  });
  fs.writeFileSync(path.join(directory, "client.map"), map);
  fs.writeFileSync(path.join(directory, "server-main.mjs.map"), serverMap);
  fs.writeFileSync(path.join(directory, "server-executor.mjs.map"), executorMap);

  try {
    const sourceMaps = new FileIncidentSourceMaps(appDir);
    assert.equal(
      sourceMaps.symbolize(
        "client",
        "build-1",
        "Error: boom\n    at a (blob:https://classapp.test/random-uuid:1:812)",
      ),
      "Error: boom\n    at runExample (client/interact/example.ts:1:1)",
    );
    assert.equal(
      sourceMaps.symbolize(
        "client",
        "another-build",
        "Error: boom\n    at a (blob:https://classapp.test/random-uuid:1:812)",
      ),
      "Error: boom\n    at a (blob:https://classapp.test/random-uuid:1:812)",
    );
    assert.equal(
      sourceMaps.symbolize(
        "server",
        "build-1",
        "Error: boom\n    at a (file:///opt/classapp/current/server/main.mjs:1:1)",
      ),
      "Error: boom\n    at runCoordinator (server/runtime/coordinator.ts:1:1)",
    );
    assert.equal(
      sourceMaps.symbolize(
        "server",
        "build-1",
        "Error: boom\n    at a (file:///opt/classapp/current/server/executor.mjs:1:1)",
      ),
      "Error: boom\n    at runJob (server/runtime/executorWorkerMain.ts:1:1)",
    );
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});
