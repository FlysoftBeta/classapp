import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileIncidentSourceMaps } from "./incidentSourceMaps";

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "classapp-source-map-"));
const directory = path.join(appDir, "server", "source-maps");
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(
  path.join(directory, "manifest.json"),
  JSON.stringify({
    format: "classapp-source-maps-v1",
    buildId: "build-1",
    maps: { client: "client.map", server: "server.map" },
  }),
);
const map = JSON.stringify({
  version: 3,
  file: "app.js",
  sources: ["client/interact/example.ts"],
  names: ["runExample"],
  mappings: "AAAAA",
});
fs.writeFileSync(path.join(directory, "client.map"), map);
fs.writeFileSync(path.join(directory, "server.map"), map);

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
} finally {
  fs.rmSync(appDir, { recursive: true, force: true });
}

console.log("incident source map tests passed");
