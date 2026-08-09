import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { worktreePath } from "../paths.mjs";
import {
  createProductionTestRuntime,
  freePort,
  readDeploymentHttpsDomain,
  removeProductionTestRuntime,
  startProductionLauncher,
  stopProcesses,
  waitForLauncher,
} from "./prod-runtime.mjs";

async function openSystemBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : process.platform === "win32"
        ? { executable: "explorer.exe", args: [url] }
        : { executable: "xdg-open", args: [url] };
  const opener = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
  });

  await new Promise<void>((resolve, reject) => {
    opener.once("spawn", resolve);
    opener.once("error", reject);
  });
  opener.unref();
}

async function waitForStop(launcher: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = () => resolve();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    launcher.once("exit", (code, signal) => {
      reject(
        new Error(
          `Launcher exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`})`,
        ),
      );
    });
    launcher.once("error", reject);
  });
}

async function main(): Promise<void> {
  const productionDatabase = worktreePath("prod.db");
  const runtime = await createProductionTestRuntime({
    prefix: "classapp-manual-",
    database: productionDatabase,
  });
  let launcher: ChildProcess | undefined;

  try {
    const httpPort = await freePort();
    const httpsDomain = await readDeploymentHttpsDomain(runtime.deployment);
    const securePort = httpsDomain ? await freePort() : null;
    launcher = startProductionLauncher({
      deployment: runtime.deployment,
      httpPort,
      securePort: securePort ?? undefined,
      httpsRedirectOverride: false,
      debugOverride: true,
    });
    const url = `http://127.0.0.1:${httpPort}/`;
    await waitForLauncher(
      launcher,
      async () => {
        const response = await fetch(url, { redirect: "manual" });
        return response.status === 200 || response.status === 301;
      },
      "the production server",
    );

    await openSystemBrowser(url);
    console.log(
      `Manual test opened in the system browser: ${url}\n` +
        "Press Ctrl+C to stop. The temporary copy of worktree/prod.db will then be discarded.",
    );

    await waitForStop(launcher);
  } finally {
    await stopProcesses([launcher]);
    await removeProductionTestRuntime(runtime);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
