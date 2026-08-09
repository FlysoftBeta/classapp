import path from "node:path";
import { buildChrome70Wasm } from "./build-wasm.mjs";
import { projectRoot } from "../paths.mjs";

const crateDirectory = path.join(projectRoot, "lib", "zstd-web");

buildChrome70Wasm({
  crateDirectory,
  outputDirectory: path.join(crateDirectory, "pkg"),
  outputName: "zstd_web",
  workingDirectory: projectRoot,
});
