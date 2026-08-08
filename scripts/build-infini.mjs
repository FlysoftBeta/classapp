import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChrome70Wasm } from "./build-wasm.mjs";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const infiniDirectory = path.join(projectDirectory, "lib", "infini");
const crateDirectory = path.join(infiniDirectory, "crates", "infini-wasm");
const outputDirectory = path.join(
  infiniDirectory,
  "packages",
  "infini-core",
  "src",
  "runtime",
  "wasm",
);
if (!existsSync(path.join(infiniDirectory, "Cargo.toml"))) {
  throw new Error(
    "Infini submodule is missing; run: git submodule update --init --recursive",
  );
}

buildChrome70Wasm({
  crateDirectory,
  outputDirectory,
  outputName: "infini_wasm",
  workingDirectory: infiniDirectory,
});
