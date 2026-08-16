import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { delay } from "./throttle";
import { MediaError } from "./errors";

export interface PotServerOptions {
  entry: string | null;
  nodePath?: string;
  timeoutMs?: number;
}

/**
 * Supervises the separately-distributed bgutil POT provider over loopback.
 * The provider is a GPL-3.0 child process with an HTTP boundary; ClassApp only
 * communicates with it through `base_url` and never imports its code.
 */
export class PotServerSupervisor {
  private child: ChildProcess | null = null;
  private actualPort: number | null = null;
  private stopping = false;

  constructor(private readonly options: PotServerOptions) {}

  get available(): boolean {
    return this.options.entry !== null && this.actualPort !== null;
  }

  get baseUrl(): string | null {
    return this.actualPort === null
      ? null
      : `http://127.0.0.1:${this.actualPort}`;
  }

  async start(): Promise<string | null> {
    if (!this.options.entry) return null;
    if (this.actualPort !== null) return this.baseUrl;
    const port = await freePort();
    const nodePath = this.options.nodePath ?? process.execPath;
    this.stopping = false;
    this.child = spawn(nodePath, [this.options.entry, "--port", String(port)], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const startup = new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => {
        reject(new MediaError("pot-unavailable", "POT server startup timed out", true));
      }, this.options.timeoutMs ?? 20_000);
      this.child?.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (/Started POT server/i.test(text)) {
          clearTimeout(timeout);
          resolve(`http://127.0.0.1:${port}`);
        }
      });
      this.child?.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      this.child?.once("error", (error) => {
        clearTimeout(timeout);
        reject(new MediaError("pot-unavailable", `POT server failed to start: ${error.message}`, true));
      });
      this.child?.once("exit", (code) => {
        clearTimeout(timeout);
        reject(
          new MediaError(
            "pot-unavailable",
            `POT server exited before startup (code ${code ?? "unknown"}): ${stderr.slice(-400)}`,
            true,
          ),
        );
      });
    });

    try {
      const baseUrl = await startup;
      this.actualPort = port;
      await this.waitHealthy(baseUrl);
      return baseUrl;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async waitHealthy(baseUrl: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}/ping`);
        if (response.ok) return;
      } catch {
        // The startup log normally arrives only after listen succeeds.
      }
      await delay(250);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.actualPort = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.killed) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 3_000).unref();
      }
      setTimeout(resolve, 5_000).unref();
    });
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Failed to allocate POT server port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
