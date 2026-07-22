import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = ["dev:server", "dev:client"].map((script) =>
  spawn(npm, ["run", script], { stdio: "inherit" }),
);

let shuttingDown = false;

function shutdown(signal = "SIGTERM", exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }

  process.exitCode = exitCode;
}

for (const child of children) {
  child.once("error", (error) => {
    console.error(error);
    shutdown("SIGTERM", 1);
  });
  child.once("exit", (code, signal) => {
    if (!shuttingDown) shutdown("SIGTERM", signal ? 1 : (code ?? 1));
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
