import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { launchChrome70, prepareChrome70 } from "./chrome70.mjs";

const generatedDirectory = path.resolve(
  "lib/infini/packages/infini-core/src/runtime/wasm",
);

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string): Promise<string> {
    const response = await this.send<{
      result: { value?: string; description?: string };
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
    return response.result.value ?? "";
  }

  close(): void {
    this.socket.close();
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
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    browser.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools was ready (${code})`));
    });
    browser.once("error", reject);
  });
}

async function main(): Promise<void> {
  const [glue, wasm] = await Promise.all([
    readFile(path.join(generatedDirectory, "infini_wasm.js")),
    readFile(path.join(generatedDirectory, "infini_wasm_bg.wasm")),
  ]);
  const html = `<!doctype html><body data-result="running"><script>
    window.addEventListener("error", function (event) {
      document.body.dataset.result = "failed";
      document.body.textContent = event.message || "module load failed";
    });
    window.addEventListener("unhandledrejection", function (event) {
      var reason = event.reason;
      document.body.dataset.result = "failed";
      document.body.textContent = reason && (reason.stack || reason.message) || String(reason);
    });
  </script><script type="module">
    import init, { InfiniEngine } from "/infini_wasm.js";
    (async function () { try {
      const exports = await init("/infini_wasm_bg.wasm");
      const engine = new InfiniEngine(48);
      const view = {
        scroll: 0,
        viewport: 600,
        insetStart: 0,
        insetEnd: 0,
        layoutBefore: 600,
        layoutAfter: 600
      };
      engine.setView(view);
      exports.memory.grow(2);
      engine.setView(Object.assign({}, view, { scroll: 1 }));
      engine.measure([]);
      engine.free();
      document.body.dataset.result = "passed";
    } catch (error) {
      document.body.dataset.result = "failed";
      document.body.textContent = error && (error.stack || error.message) || String(error);
    } })();
  </script></body>`;
  const server = createServer((request, response) => {
    if (request.url === "/infini_wasm.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(glue);
      return;
    }
    if (request.url === "/infini_wasm_bg.wasm") {
      response.setHeader("Content-Type", "application/wasm");
      response.end(wasm);
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");

  const profile = await mkdtemp(path.join(tmpdir(), "infini-chrome70-"));
  let chromeProcess: ChildProcess | undefined;
  let cdp: CdpClient | undefined;
  try {
    const chrome = await prepareChrome70();
    chromeProcess = launchChrome70(chrome, {
      userDataDir: profile,
      url: "about:blank",
      headless: true,
      remoteDebugging: true,
    });
    const browserWs = await waitForDevtools(chromeProcess);
    const debugPort = new URL(browserWs).port;
    const targets = (await fetch(
      `http://127.0.0.1:${debugPort}/json/list`,
    ).then((response) => response.json())) as Array<{
      type: string;
      webSocketDebuggerUrl: string;
    }>;
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome 70 did not expose a page target");
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", {
      url: `http://127.0.0.1:${address.port}/`,
    });
    const deadline = Date.now() + 30_000;
    while (true) {
      const result = await cdp.evaluate(
        `document.body && document.body.dataset.result || ""`,
      );
      if (result === "passed") break;
      if (result === "failed") {
        throw new Error(await cdp.evaluate(`document.body.innerText`));
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Infini test timed out: ${await cdp.evaluate(`document.documentElement.outerHTML`)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    console.log(`${chrome.version} Infini memory growth passed`);
  } finally {
    cdp?.close();
    if (chromeProcess && chromeProcess.exitCode === null) chromeProcess.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
}

await main();
