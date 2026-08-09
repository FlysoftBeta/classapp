import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import path from "node:path";
import process from "node:process";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { launchChrome70, prepareChrome70, type Chrome70 } from "./chrome70.mjs";
import {
  createProductionTestRuntime,
  freePort,
  removeProductionTestRuntime,
  startProductionLauncher,
  stopProcess,
  stopProcesses,
  waitForExit,
  waitForLauncher,
} from "./production-test-runtime.mjs";
const TLS_HOST = "classapp.duckdns.org";
const LEGACY_HOST = "www.opensubtitles.org";

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly events = new Map<string, Array<(params: unknown) => void>>();

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

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const response = await this.send<{
      result: { value?: T; description?: string };
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
    return response.result.value as T;
  }
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

async function connectCdp(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return new CdpClient(socket);
}

async function waitForExpression(
  cdp: CdpClient,
  expression: string,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  await cdp.evaluate(`new Promise((resolve, reject) => {
    var deadline = Date.now() + ${timeoutMs};
    var check = function () {
      try {
        if (${expression}) return resolve(true);
      } catch (_) {}
      if (Date.now() >= deadline)
        return reject(new Error(${JSON.stringify(`Timed out: ${description}`)}));
      setTimeout(check, 50);
    };
    check();
  })`);
}

async function waitForText(
  cdp: CdpClient,
  text: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitForExpression(
    cdp,
    `((document.body && document.body.innerText) || "").indexOf(${JSON.stringify(text)}) !== -1`,
    `text ${text}`,
    timeoutMs,
  );
}

function trustedHttpsRequest(
  port: number,
  requestPath = "/",
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        servername: TLS_HOST,
        rejectUnauthorized: true,
        headers: { Host: `${TLS_HOST}:${port}` },
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
          }),
        );
      },
    );
    request.once("error", reject);
  });
}

async function waitForServer(
  child: ChildProcess,
  securePort: number,
): Promise<void> {
  await waitForLauncher(
    child,
    async () => {
      const response = await trustedHttpsRequest(securePort);
      return response.status === 200;
    },
    "the HTTPS production server",
  );
}

function startLauncher(
  deployment: string,
  httpPort: number,
  securePort: number,
): { child: ChildProcess; adminPin: Promise<string> } {
  const child = startProductionLauncher({
    deployment,
    httpPort,
    securePort,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let resolvePin: ((pin: string) => void) | null = null;
  let rejectPin: ((error: Error) => void) | null = null;
  const adminPin = new Promise<string>((resolve, reject) => {
    resolvePin = resolve;
    rejectPin = reject;
  });
  const collect = (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
    const match = output.match(/管理员 PIN 码：(\d{6})/);
    if (match && resolvePin) {
      resolvePin(match[1]);
      resolvePin = null;
      rejectPin = null;
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.once("exit", (code) => {
    if (rejectPin) rejectPin(new Error(`Launcher exited with code ${code}`));
  });
  return { child, adminPin };
}

async function launchChrome(
  chrome: Chrome70,
  profile: string,
): Promise<{ browser: ChildProcess; cdp: CdpClient }> {
  const hostRules = [
    `MAP ${TLS_HOST} 127.0.0.1`,
    `MAP ${LEGACY_HOST} 127.0.0.1`,
  ];
  const browser = launchChrome70(chrome, {
    userDataDir: profile,
    url: "about:blank",
    headless: true,
    hostResolverRules: hostRules,
    remoteDebugging: true,
  });
  const browserWs = await waitForDevtools(browser);
  const debugPort = new URL(browserWs).port;
  const targets = (await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(
    (response) => response.json(),
  )) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("Chrome did not expose a page target");
  return { browser, cdp: await connectCdp(page.webSocketDebuggerUrl) };
}

async function enterKonamiAndLogin(cdp: CdpClient, pin: string): Promise<void> {
  await cdp.evaluate(`(async function () {
    var deadline = Date.now() + 20000;
    var lock;
    while (!(lock = document.querySelector('[aria-label="锁定屏幕"]'))) {
      if (Date.now() >= deadline) throw new Error("Lock screen not found");
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
    }
    lock.focus();
    var keys = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
      "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight"];
    for (var index = 0; index < keys.length; index += 1) {
      lock.dispatchEvent(new KeyboardEvent("keydown", {
        key: keys[index],
        bubbles: true
      }));
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
    }
  })()`);
  await waitForText(cdp, "登录");
  await cdp.evaluate(`(async function () {
    var pin = ${JSON.stringify(pin)};
    for (var index = 0; index < pin.length; index += 1) {
      var digit = pin[index];
      var buttons = Array.prototype.slice.call(document.querySelectorAll("button"));
      var button = buttons.find(function (candidate) {
        return candidate.textContent.trim() === digit;
      });
      if (!button) throw new Error("PIN button not found: " + digit);
      button.click();
      await new Promise(function (resolve) { setTimeout(resolve, 75); });
    }
  })()`);
  await waitForText(cdp, "Baker");
}

async function openChatConversation(
  cdp: CdpClient,
  conversationName: string,
): Promise<void> {
  await cdp.evaluate(`(async function () {
    var name = ${JSON.stringify(conversationName)};
    var deadline = Date.now() + 20000;
    var button;
    while (!button) {
      var candidates = Array.prototype.slice.call(
        document.querySelectorAll('[role="button"]')
      );
      button = candidates.find(function (candidate) {
        return candidate.textContent.trim() === name;
      });
      if (button) break;
      if (Date.now() >= deadline) {
        throw new Error("Conversation not found: " + name);
      }
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
    }
    button.click();
  })()`);
  await waitForText(cdp, `# ${conversationName}`);
  await waitForExpression(
    cdp,
    `!!document.querySelector('textarea[placeholder="发送消息…"]')`,
    `chat composer for ${conversationName}`,
  );
}

async function inspectHttpsAdminPanel(cdp: CdpClient): Promise<void> {
  await cdp.evaluate(`(function () {
    var button = document.querySelector('button[aria-label="管理后台"]');
    if (!button) {
      var icon = document.querySelector('[data-testid="AdminPanelSettingsIcon"]');
      button = icon && icon.parentElement;
    }
    if (!button) {
      var spans = Array.prototype.slice.call(document.querySelectorAll("span"));
      var handle = spans.find(function (candidate) {
        return candidate.textContent.trim() === "@admin";
      });
      var bar = handle && handle.parentElement && handle.parentElement.parentElement;
      button = bar && bar.querySelector("button");
    }
    if (!button) throw new Error("Admin button not found");
    button.click();
  })()`);
  await waitForText(cdp, "管理后台");
  await waitForExpression(
    cdp,
    `Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'))
      .some(function (candidate) {
        return candidate.textContent.trim() === "运维";
      })`,
    "admin maintenance tab",
  );
  await cdp.evaluate(`(function () {
    var tabs = Array.prototype.slice.call(
      document.querySelectorAll('[role="tab"]')
    );
    var tab = tabs.find(function (candidate) {
      return candidate.textContent.trim() === "运维";
    });
    if (!tab) throw new Error("Maintenance tab not found");
    tab.click();
  })()`);
  await waitForText(cdp, "HTTPS 升级");
  await waitForText(cdp, "证书有效");
  await waitForText(cdp, "ISRG Root X1");
  const redirectEnabled = await cdp.evaluate<boolean>(`(function () {
    var labels = Array.prototype.slice.call(document.querySelectorAll("label"));
    var label = labels.find(function (candidate) {
      return candidate.textContent.indexOf("将 HTTP shell 入口永久重定向到 HTTPS") !== -1;
    });
    var input = label && label.querySelector('input[type="checkbox"]');
    return !!(input && input.checked);
  })()`);
  assert.equal(redirectEnabled, true, "HTTPS redirect switch is not enabled");
}

async function indexedBundleCount(cdp: CdpClient): Promise<number> {
  return cdp.evaluate<number>(`new Promise(function (resolve, reject) {
    var request = indexedDB.open("classapp-runtime", 4);
    request.onerror = function () { reject(request.error); };
    request.onsuccess = function () {
      var count = request.result
        .transaction("bundles")
        .objectStore("bundles")
        .count();
      count.onerror = function () { reject(count.error); };
      count.onsuccess = function () { resolve(count.result); };
    };
  })`);
}

async function main(): Promise<void> {
  const sourceDeployment = path.join(process.cwd(), "build", "deploy");
  const certificate = path.join(
    sourceDeployment,
    "current",
    "https",
    "fullchain.pem",
  );
  await readFile(certificate).catch(() => {
    throw new Error(
      "HTTPS deployment certificate is missing; run npm run https:renew first",
    );
  });

  const runtime = await createProductionTestRuntime({
    prefix: "classapp-chrome70-",
  });
  const launchers: ChildProcess[] = [];
  let browser: ChildProcess | undefined;
  let cdp: CdpClient | undefined;

  try {
    const [httpPort, securePort] = await Promise.all([freePort(), freePort()]);
    assert.notEqual(httpPort, securePort);

    const first = startLauncher(runtime.deployment, httpPort, securePort);
    launchers.push(first.child);
    await waitForServer(first.child, securePort);
    const initialHttp = await fetch(`http://127.0.0.1:${httpPort}/`);
    assert.equal(initialHttp.status, 200);
    const adminPin = await Promise.race([
      first.adminPin,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Timed out waiting for the production PIN")),
          30_000,
        ),
      ),
    ]);

    const database = new Database(path.join(runtime.deployment, "data.db"));
    database
      .prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)")
      .run("https_redirect_enabled", "1");
    database.close();

    const directTls = await trustedHttpsRequest(securePort);
    assert.equal(directTls.status, 200);
    assert.equal(directTls.headers["cache-control"], "no-store, max-age=0");

    const legacyUrl = `http://${LEGACY_HOST}:${httpPort}/`;
    const secureUrl = `https://${TLS_HOST}:${securePort}/`;
    const redirect = await fetch(`http://127.0.0.1:${httpPort}/`, {
      redirect: "manual",
    });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("location"), secureUrl);
    assert.equal(
      redirect.headers.get("cache-control"),
      "public, max-age=315360000, immutable",
    );

    const chrome = await prepareChrome70();
    const launched = await launchChrome(chrome, runtime.profile);
    browser = launched.browser;
    cdp = launched.cdp;
    const onlineFailures: string[] = [];
    cdp.on<{
      exceptionDetails: { text: string; exception?: { description?: string } };
    }>("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      onlineFailures.push(
        `pageerror: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
      );
    });
    cdp.on<{
      type: string;
      args: Array<{ value?: unknown; description?: string }>;
    }>("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type === "error") {
        onlineFailures.push(
          `console: ${args
            .map((argument) => argument.value ?? argument.description)
            .join(" ")}`,
        );
      }
    });
    cdp.on<{ errorType: string }>("Security.certificateError", (event) => {
      onlineFailures.push(`certificate: ${event.errorType}`);
    });
    await Promise.all([
      cdp.send("Runtime.enable"),
      cdp.send("Log.enable"),
      cdp.send("Page.enable"),
      cdp.send("Network.enable"),
      cdp.send("Security.enable"),
    ]);

    await cdp.send("Page.navigate", { url: legacyUrl });
    await waitForExpression(
      cdp,
      `location.href.indexOf(${JSON.stringify(secureUrl)}) === 0`,
      "legacy URL to permanently redirect to the configured HTTPS URL",
      30_000,
    );
    try {
      await enterKonamiAndLogin(cdp, adminPin);
    } catch (error) {
      const diagnostics = await cdp.evaluate(`JSON.stringify({
        href: location.href,
        title: document.title,
        body: ((document.body && document.body.innerText) || "").slice(0, 2000),
        scripts: document.scripts.length,
        styles: document.querySelectorAll("style, link[rel=stylesheet]").length,
        controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller)
      })`);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${onlineFailures.join("\n")}\npage: ${String(diagnostics)}`,
      );
    }
    await waitForExpression(
      cdp,
      `navigator.serviceWorker && navigator.serviceWorker.controller`,
      "Service Worker control",
      30_000,
    );
    assert.equal(await indexedBundleCount(cdp), 1);
    const endpoints = await cdp.evaluate<string[]>(
      `fetch("/api/endpoints").then(function (response) {
        return response.json();
      }).then(function (data) { return data.origins; })`,
    );
    assert.deepEqual(endpoints, [`https://${TLS_HOST}:${securePort}`]);
    await openChatConversation(cdp, "大别野");
    await inspectHttpsAdminPanel(cdp);
    if (onlineFailures.length > 0) {
      throw new Error(onlineFailures.join("\n"));
    }

    stopProcess(first.child);
    await waitForExit(first.child);
    await new Promise((resolve) => setTimeout(resolve, 300));
    onlineFailures.length = 0;

    await cdp.send("Page.navigate", { url: legacyUrl });
    await waitForExpression(
      cdp,
      `location.href.indexOf(${JSON.stringify(secureUrl)}) === 0`,
      "cached 301 to be usable while the origin is down",
      30_000,
    );
    try {
      await waitForText(cdp, "离线", 35_000);
      await waitForText(cdp, "大别野", 5_000);
    } catch (error) {
      const diagnostics = await cdp.evaluate(`JSON.stringify({
        href: location.href,
        title: document.title,
        body: ((document.body && document.body.innerText) || "").slice(0, 2000),
        scripts: document.scripts.length,
        styles: document.querySelectorAll("style, link[rel=stylesheet]").length,
        controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller)
      })`);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${onlineFailures.join("\n")}\npage: ${String(diagnostics)}`,
      );
    }
    const offlineState = await cdp.evaluate<{
      controlled: boolean;
      bundleCount: number;
      body: string;
    }>(`(async function () {
      var request = indexedDB.open("classapp-runtime", 4);
      var bundleCount = await new Promise(function (resolve, reject) {
        request.onerror = function () { reject(request.error); };
        request.onsuccess = function () {
          var count = request.result
            .transaction("bundles")
            .objectStore("bundles")
            .count();
          count.onerror = function () { reject(count.error); };
          count.onsuccess = function () { resolve(count.result); };
        };
      });
      return {
        controlled: !!navigator.serviceWorker.controller,
        bundleCount: bundleCount,
        body: (document.body && document.body.innerText) || ""
      };
    })()`);
    assert.equal(offlineState.controlled, true);
    assert.equal(offlineState.bundleCount, 1);
    assert.doesNotMatch(offlineState.body, /应用无法加载/);

    const second = startLauncher(runtime.deployment, httpPort, securePort);
    second.adminPin.catch(() => undefined);
    launchers.push(second.child);
    await waitForServer(second.child, securePort);
    await cdp.send("Page.navigate", { url: secureUrl });
    await waitForText(cdp, "Baker", 30_000);

    console.log(
      `Chrome 70 HTTPS/offline E2E passed (${chrome.version}, uid=${process.getuid?.() ?? "n/a"}, ports=${httpPort}/${securePort})`,
    );
  } finally {
    if (cdp) await cdp.send("Browser.close").catch(() => undefined);
    await stopProcesses([browser, ...launchers]);
    // The launcher can exit just before its server child finishes handling
    // SIGTERM. Keep the temporary deployment alive for that final drain.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await removeProductionTestRuntime(runtime);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
