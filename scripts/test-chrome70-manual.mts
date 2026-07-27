import type { ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { launchChrome70, prepareChrome70 } from "./chrome70.mjs";
import {
  createProductionTestRuntime,
  freePort,
  readDeploymentHttpsDomain,
  removeProductionTestRuntime,
  startProductionLauncher,
  stopProcesses,
  waitForLauncher,
} from "./production-test-runtime.mjs";

async function main(): Promise<void> {
  const root = process.cwd();
  const productionDatabase = path.join(root, "prod.db");
  const runtime = await createProductionTestRuntime({
    prefix: "classapp-chrome70-manual-",
    database: productionDatabase,
  });
  let launcher: ChildProcess | undefined;
  let browser: ChildProcess | undefined;

  try {
    const httpPort = await freePort();
    const httpsDomain = await readDeploymentHttpsDomain(runtime.deployment);
    const securePort = httpsDomain ? await freePort() : null;
    const chrome = await prepareChrome70();

    launcher = startProductionLauncher({
      deployment: runtime.deployment,
      httpPort,
      securePort: securePort ?? undefined,
    });
    await waitForLauncher(
      launcher,
      async () => {
        const response = await fetch(`http://127.0.0.1:${httpPort}/`, {
          redirect: "manual",
        });
        return response.status === 200 || response.status === 301;
      },
      "the production server",
    );

    const url = `http://127.0.0.1:${httpPort}/`;
    const launchedBrowser = launchChrome70(chrome, {
      userDataDir: runtime.profile,
      url,
      hostResolverRules: httpsDomain
        ? [`MAP ${httpsDomain} 127.0.0.1`]
        : undefined,
    });
    browser = launchedBrowser;
    launchedBrowser.stderr?.pipe(process.stderr);

    console.log(
      `Manual test opened in ${chrome.version}: ${url}\n` +
        "The prod.db copy and Chrome user data will be discarded when Chrome exits.",
    );

    await new Promise<void>((resolve, reject) => {
      const finish = () => resolve();
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      launchedBrowser.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else {
          reject(
            new Error(
              `Chrome exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`})`,
            ),
          );
        }
      });
      launchedBrowser.once("error", reject);
      launcher?.once("exit", (code) => {
        if (launchedBrowser.exitCode === null) {
          reject(new Error(`Launcher exited with code ${code}`));
        }
      });
    });
  } finally {
    await stopProcesses([browser, launcher]);
    await removeProductionTestRuntime(runtime);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
