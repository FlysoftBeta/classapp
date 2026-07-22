import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rustDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../rust",
);
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const test = spawnSync(cargo, ["test", "--locked", "--all-targets"], {
  cwd: rustDirectory,
  encoding: "utf8",
  stdio: "inherit",
});
if (test.error) throw test.error;
process.exit(test.status ?? 1);
