import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import { access, cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

type CreateProductionTestRuntimeOptions = {
  prefix: string;
  database?: string;
};

type ProductionTestRuntime = {
  temporaryRoot: string;
  deployment: string;
  profile: string;
};

type StartProductionLauncherOptions = {
  deployment: string;
  httpPort: number;
  securePort?: number;
  stdio?: StdioOptions;
};

export async function createProductionTestRuntime(
  options: CreateProductionTestRuntimeOptions,
): Promise<ProductionTestRuntime> {
  const root = process.cwd();
  const sourceDeployment = path.join(root, "build", "deploy");
  await access(sourceDeployment);
  if (options.database) await access(options.database);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), options.prefix));
  const deployment = path.join(temporaryRoot, "deployment");
  const profile = path.join(temporaryRoot, "profile");

  try {
    await cp(sourceDeployment, deployment, { recursive: true });
    const entries = await readdir(deployment);
    await Promise.all(
      entries
        .filter(
          (name) => name.startsWith("data.db") || name === ".launcher-pid",
        )
        .map((name) =>
          rm(path.join(deployment, name), { recursive: true, force: true }),
        ),
    );
    if (options.database) {
      await cp(options.database, path.join(deployment, "data.db"));
    }
    return { temporaryRoot, deployment, profile };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function readDeploymentHttpsDomain(
  deployment: string,
): Promise<string | null> {
  try {
    const config = JSON.parse(
      await readFile(
        path.join(deployment, "current", "https", "config.json"),
        "utf8",
      ),
    ) as { domain?: unknown };
    return typeof config.domain === "string" && config.domain.trim()
      ? config.domain.trim().toLowerCase()
      : null;
  } catch {
    return null;
  }
}

export async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert(port >= 1024, `Expected an unprivileged port, received ${port}`);
  return port;
}

export function startProductionLauncher(
  options: StartProductionLauncherOptions,
): ChildProcess {
  return spawn(process.execPath, ["launcher.js"], {
    cwd: options.deployment,
    detached: true,
    stdio: options.stdio ?? "inherit",
    env: {
      ...process.env,
      CLASSAPP_PORTS: String(options.httpPort),
      CLASSAPP_SECURE_PORTS:
        options.securePort === undefined ? "" : String(options.securePort),
    },
  });
}

export async function waitForLauncher(
  child: ChildProcess,
  probe: () => Promise<boolean>,
  description: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Launcher exited with code ${child.exitCode}`);
    }
    try {
      if (await probe()) return;
    } catch {
      // The production launcher is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export function stopProcess(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export async function waitForExit(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for process exit")),
      timeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export async function stopProcesses(
  children: Array<ChildProcess | undefined>,
): Promise<void> {
  const running = children.filter(
    (child): child is ChildProcess => child !== undefined,
  );
  for (const child of running) stopProcess(child);
  await Promise.all(
    running.map((child) => waitForExit(child, 5_000).catch(() => undefined)),
  );
}

export async function removeProductionTestRuntime(
  runtime: ProductionTestRuntime,
): Promise<void> {
  await rm(runtime.temporaryRoot, { recursive: true, force: true });
}
