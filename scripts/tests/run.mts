import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "../paths.mjs";

const kind = process.argv[2];
if (kind !== "unit" && kind !== "smoke") {
  console.error("Usage: node --import tsx scripts/tests/run.mts <unit|smoke>");
  process.exit(2);
}

const files = (
  await Array.fromAsync(glob(`scripts/tests/${kind}/**/*.test.ts`, { cwd: projectRoot }))
)
  .map((file) => path.join(projectRoot, file))
  .sort();

if (files.length === 0) {
  console.error(`No ${kind} tests found`);
  process.exit(1);
}

const args = [
  "--import",
  "tsx",
  "--test",
  "--test-isolation=none",
  "--test-reporter=spec",
  `--test-timeout=${kind === "smoke" ? "120000" : "30000"}`,
];
if (kind === "smoke") args.push("--test-concurrency=1");
args.push(...files);

const child = spawn(process.execPath, args, {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    CLASSAPP_EXECUTORS: "1",
  },
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
