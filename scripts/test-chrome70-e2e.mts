import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import WebSocket from "ws";

const DEB = path.join(import.meta.dirname, "google-chrome-stable_current_amd64.deb");
const EXPECTED_SHA256 =
  "d7f8866b202deb82cbeffa2d66b26ad8f59dafed24aa0422e166541e5a724c20";
const EXPECTED_VERSION = "Google Chrome 70.0.3538.77";
const APP_URL = "http://127.0.0.1:3000";

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly events = new Map<string, Array<(params: unknown) => void>>();

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      for (const listener of this.events.get(message.method) ?? []) {
        listener(message.params);
      }
    });
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on<T>(method: string, listener: (params: T) => void): void {
    const listeners = this.events.get(method) ?? [];
    listeners.push(listener as (params: unknown) => void);
    this.events.set(method, listeners);
  }

  async evaluate(expression: string): Promise<unknown> {
    const response = await this.send<{
      result: { value?: unknown; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text,
      );
    }
    return response.result.value;
  }
}

function stopProcess(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function connectCdp(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return new CdpClient(socket);
}

function waitForDevtools(browser: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for Chrome DevTools")),
      30_000,
    );
    browser.stderr?.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    browser.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools was ready (${code})`));
    });
  });
}

async function waitForText(cdp: CdpClient, text: string): Promise<void> {
  await cdp.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const check = () => {
      if (((document.body && document.body.innerText) || "").includes(${JSON.stringify(text)})) return resolve(true);
      if (Date.now() >= deadline) return reject(new Error("Text not found: " + ${JSON.stringify(text)}));
      setTimeout(check, 50);
    };
    check();
  })`);
}

async function clickByLabel(cdp: CdpClient, label: string): Promise<void> {
  await cdp.evaluate(`(() => {
    const element = document.querySelector('[aria-label=${JSON.stringify(label)}]');
    if (!element) throw new Error("Control not found: " + ${JSON.stringify(label)});
    element.click();
  })()`);
}

async function waitForServer(children: ChildProcess[]): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const exited = children.find((child) => child.exitCode !== null);
    if (exited) {
      throw new Error(`Application server exited with code ${exited.exitCode}`);
    }
    try {
      const [frontend, endpoint] = await Promise.all([
        fetch(APP_URL),
        fetch(`${APP_URL}/api/endpoints`),
      ]);
      if (frontend.ok && endpoint.ok) return;
    } catch {
      // The development servers are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${APP_URL}`);
}

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "classapp-chrome70-"),
  );
  const extracted = path.join(temporaryRoot, "chrome");
  const profile = path.join(temporaryRoot, "profile");
  const dataRoot = path.join(temporaryRoot, "data");
  const appRoot = path.join(temporaryRoot, "app");
  const servers: ChildProcess[] = [];
  let browser: ChildProcess | undefined;
  let cdp: CdpClient | undefined;

  try {
    const digest = createHash("sha256")
      .update(await readFile(DEB))
      .digest("hex");
    if (digest !== EXPECTED_SHA256) {
      throw new Error(`Chrome 70 package hash mismatch: ${digest}`);
    }

    const debParts = path.join(temporaryRoot, "deb");
    await mkdir(debParts);
    await mkdir(extracted);
    const unpackDeb = spawnSync("/usr/bin/ar", ["x", DEB, "data.tar.xz"], {
      encoding: "utf8",
      cwd: debParts,
    });
    if (unpackDeb.error) throw unpackDeb.error;
    if (unpackDeb.status !== 0) {
      throw new Error(unpackDeb.stderr || "Could not unpack Chrome package");
    }
    const extraction = spawnSync(
      "/usr/bin/tar",
      ["-xJf", path.join(debParts, "data.tar.xz"), "-C", extracted],
      { encoding: "utf8" },
    );
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0) {
      throw new Error(extraction.stderr || "Could not extract Chrome payload");
    }

    const executable = path.join(extracted, "opt/google/chrome/google-chrome");
    const version = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: temporaryRoot,
        XDG_CONFIG_HOME: path.join(temporaryRoot, "config"),
        XDG_CACHE_HOME: path.join(temporaryRoot, "cache"),
      },
    });
    if (version.error) throw version.error;
    if (version.stdout.trim() !== EXPECTED_VERSION) {
      throw new Error(`Unexpected Chrome version: ${version.stdout.trim()}`);
    }

    await mkdir(dataRoot);
    await mkdir(path.join(appRoot, "client/app"), { recursive: true });
    await cp(
      path.join(process.cwd(), "dist/client/app/app.js"),
      path.join(appRoot, "client/app/app.js"),
    );
    await cp(path.join(process.cwd(), "public"), path.join(appRoot, "public"), {
      recursive: true,
    });
    await writeFile(
      path.join(appRoot, "shell.html"),
      '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/app/app.js"></script></body></html>',
    );

    const buildId = (
      await readFile(path.join(process.cwd(), "dist/build-id.txt"), "utf8")
    ).trim();
    const backend = spawn(
      path.join(process.cwd(), "node_modules/.bin/tsx"),
      ["server/dev.ts"],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CLASSAPP_APP_DIR: appRoot,
          CLASSAPP_BUILD_ID: buildId,
          CLASSAPP_DATA_ROOT: dataRoot,
          CLASSAPP_PORT: "3000",
        },
        detached: true,
      },
    );
    servers.push(backend);
    for (const server of servers) {
      server.stdout?.pipe(process.stdout);
      server.stderr?.pipe(process.stderr);
    }
    await waitForServer(servers);

    browser = spawn(
      executable,
      [
        "--headless",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "about:blank",
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
        env: {
          ...process.env,
          HOME: temporaryRoot,
          XDG_CONFIG_HOME: path.join(temporaryRoot, "config"),
          XDG_CACHE_HOME: path.join(temporaryRoot, "cache"),
        },
      },
    );
    const browserWs = await waitForDevtools(browser);
    const debugPort = new URL(browserWs).port;
    const targets = (await fetch(
      `http://127.0.0.1:${debugPort}/json/list`,
    ).then((response) => response.json())) as Array<{
      type: string;
      webSocketDebuggerUrl: string;
    }>;
    const pageTarget = targets.find((target) => target.type === "page");
    if (!pageTarget) throw new Error("Chrome did not expose a page target");
    cdp = await connectCdp(pageTarget.webSocketDebuggerUrl);
    const failures: string[] = [];
    cdp.on<{
      exceptionDetails: { text: string; exception?: { description?: string } };
    }>("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      failures.push(
        `pageerror: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
      );
    });
    cdp.on<{
      type: string;
      args: Array<{ value?: unknown; description?: string }>;
    }>("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type === "error") {
        failures.push(
          `console: ${args.map((argument) => argument.value ?? argument.description).join(" ")}`,
        );
      }
    });
    cdp.on<{ entry: { level: string; text: string } }>(
      "Log.entryAdded",
      ({ entry }) => {
        if (entry.level === "error") failures.push(`log: ${entry.text}`);
      },
    );
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: APP_URL });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await cdp.evaluate(`(async () => {
      const deadline = Date.now() + 15000;
      let lock;
      while (!(lock = document.querySelector('[aria-label="锁定屏幕"]'))) {
        if (Date.now() >= deadline) throw new Error("Lock screen not found");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      lock.focus();
      for (const key of ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight"]) {
        lock.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })()`);
    try {
      await waitForText(cdp, "登录");
    } catch (error) {
      const body = await cdp.evaluate(
        `JSON.stringify({
          html: document.documentElement && document.documentElement.outerHTML,
          resources: performance.getEntriesByType("resource").map((entry) => entry.name),
        })`,
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${failures.join("\n")}\npage: ${String(body)}`,
      );
    }
    await cdp.evaluate(`(async () => {
      for (const digit of "123456") {
        const button = [...document.querySelectorAll("button")].find(
          (candidate) => candidate.textContent.trim() === digit,
        );
        if (!button) throw new Error("PIN button not found: " + digit);
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    })()`);
    await waitForText(cdp, "Baker");
    await clickByLabel(cdp, "发现群组");
    await waitForText(cdp, "发现群组");
    await cdp.evaluate(
      `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
    );
    await clickByLabel(cdp, "创建群组");
    await waitForText(cdp, "创建群组");
    await cdp.evaluate(
      `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (failures.length > 0) throw new Error(failures.join("\n"));
    console.log(`Chrome 70 smoke test passed (${EXPECTED_VERSION})`);
  } finally {
    if (cdp) await cdp.send("Browser.close").catch(() => undefined);
    stopProcess(browser);
    for (const server of servers) {
      stopProcess(server);
    }
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            if (server.exitCode !== null) return resolve();
            server.once("exit", () => resolve());
            setTimeout(resolve, 5_000);
          }),
      ),
    );
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
