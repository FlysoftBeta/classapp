import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";
import { runtimeConfig } from "@/server/infra/runtimeConfig";
import { PublicError } from "@/server/services/incidentService";

const MAX_RENDER_PROCESSES = 2;
const RENDER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

let activeProcesses = 0;
const waiters: Array<() => void> = [];

async function acquireRenderSlot(): Promise<() => void> {
  if (activeProcesses >= MAX_RENDER_PROCESSES) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  activeProcesses += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeProcesses -= 1;
    waiters.shift()?.();
  };
}

function appendDiagnostic(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_DIAGNOSTIC_BYTES
    ? next.slice(next.length - MAX_DIAGNOSTIC_BYTES)
    : next;
}

/** Run one bounded render job. The upload request intentionally owns its job. */
export async function renderPdfArchive(
  sourcePath: string,
  outputPath: string,
): Promise<void> {
  const release = await acquireRenderSlot();
  try {
    const pdfRender = runtimeConfig().platform.pdfRender;
    const jobs = Math.max(
      1,
      Math.min(4, Math.ceil(availableParallelism() / 2)),
    );
    const args = [
      "--resolution",
      "96",
      "--webp-quality",
      "80",
      "--jobs",
      String(jobs),
      sourcePath,
      outputPath,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(pdfRender.rendererPath, args, {
        cwd: path.dirname(sourcePath),
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, ...pdfRender.environment },
      });
      let diagnostic = "";
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostic = appendDiagnostic(diagnostic, chunk);
      });
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, RENDER_TIMEOUT_MS);
      timeout.unref();
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
          return;
        }
        const reason = signal
          ? `pdfrender 被 ${signal} 终止`
          : `pdfrender 退出码 ${code ?? "unknown"}`;
        reject(
          new PublicError(
            "文档渲染失败",
            diagnostic.trim() ? `${reason}: ${diagnostic.trim()}` : reason,
          ),
        );
      });
    });
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError("无法启动文档渲染器", "pdfrender failed", error);
  } finally {
    release();
  }
}
