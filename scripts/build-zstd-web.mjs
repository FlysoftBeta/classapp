import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChrome70Wasm } from "./build-wasm.mjs";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const crateDirectory = path.join(projectDirectory, "lib", "zstd-web");

buildChrome70Wasm({
  crateDirectory,
  outputDirectory: path.join(crateDirectory, "pkg"),
  outputName: "zstd_web",
  workingDirectory: projectDirectory,
});
