import { client } from "@/client/lib/remote/client";
import {
  ACTIVE_BUILD_KEY,
  clearLegacyActiveBuild,
  openRuntimeDatabase,
  transactionDone,
} from "@/client/resource/runtimeDatabase";
import {
  parseRuntimeManifest,
  type RuntimeAsset,
  type RuntimeManifest,
} from "@/shared/runtimeManifest";

type WorkerReply = {
  ok: boolean;
  buildId?: string | null;
  error?: string;
};

async function fetchManifest(): Promise<RuntimeManifest> {
  const response = await fetch("/app/manifest.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`manifest ${response.status}`);
  return parseRuntimeManifest(await response.json());
}

async function fetchAsset(asset: RuntimeAsset, label: string): Promise<Blob> {
  const response = await fetch(asset.url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${label} ${response.status}`);
  const body = await response.blob();
  if (body.size !== asset.size) {
    throw new Error(`${label} size mismatch: ${body.size} != ${asset.size}`);
  }
  return body;
}

async function serviceWorker(): Promise<ServiceWorker | null> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return null;
  if (navigator.serviceWorker.controller)
    return navigator.serviceWorker.controller;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (registration?.active) return registration.active;
  const ready = navigator.serviceWorker.ready.then(
    (value) => value.active,
    () => null,
  );
  return Promise.race([
    ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
  ]);
}

async function sendWorkerMessage(
  worker: ServiceWorker,
  message: Record<string, unknown>,
): Promise<WorkerReply> {
  const channel = new MessageChannel();
  return new Promise<WorkerReply>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Service Worker response timeout")),
      10_000,
    );
    channel.port1.onmessage = (event: MessageEvent<WorkerReply>) => {
      clearTimeout(timer);
      channel.port1.close();
      const reply = event.data;
      if (!reply?.ok) {
        reject(new Error(reply?.error || "Service Worker rejected update"));
        return;
      }
      resolve(reply);
    };
    worker.postMessage(message, [channel.port2]);
  });
}

async function stageBundle(buildId: string, body: Blob): Promise<void> {
  const db = await openRuntimeDatabase();
  try {
    const tx = db.transaction("bundles", "readwrite");
    const done = transactionDone(tx);
    tx.objectStore("bundles").put({
      buildId,
      body: await body.arrayBuffer(),
      installedAt: Date.now(),
    });
    await done;
  } finally {
    db.close();
  }
}

async function activateBundle(buildId: string): Promise<void> {
  const db = await openRuntimeDatabase();
  try {
    const tx = db.transaction("kv", "readwrite");
    const done = transactionDone(tx);
    tx.objectStore("kv").put({ key: ACTIVE_BUILD_KEY, value: buildId });
    await done;
  } finally {
    db.close();
  }
  clearLegacyActiveBuild();
}

async function activeBundleBuildId(): Promise<string | null> {
  const db = await openRuntimeDatabase();
  try {
    const record = await new Promise<{ value?: unknown } | undefined>(
      (resolve, reject) => {
        const request = db
          .transaction("kv", "readonly")
          .objectStore("kv")
          .get(ACTIVE_BUILD_KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    return typeof record?.value === "string" ? record.value : null;
  } finally {
    db.close();
  }
}

async function stageShell(
  worker: ServiceWorker | null,
  buildId: string,
  body: string,
): Promise<void> {
  if (!worker) return;
  await sendWorkerMessage(worker, {
    type: "classapp:stage-shell",
    buildId,
    body,
  });
}

async function activateShell(
  worker: ServiceWorker | null,
  buildId: string,
): Promise<void> {
  if (!worker) return;
  await sendWorkerMessage(worker, {
    type: "classapp:activate-shell",
    buildId,
  });
}

async function shellBuildId(
  worker: ServiceWorker | null,
): Promise<string | null> {
  if (!worker) return null;
  const reply = await sendWorkerMessage(worker, {
    type: "classapp:get-shell-build",
  });
  return reply.buildId ?? null;
}

/** Owns every post-bootstrap application update: check, download, stage and activate. */
export class BundleManager {
  private checking = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private offHello: (() => void) | null = null;
  private readonly onRequested = () => this.requestCheck();

  constructor(private readonly currentBuildId: string) {}

  async start(): Promise<() => void> {
    if (!import.meta.env.DEV) {
      try {
        await this.check();
      } catch (error) {
        console.warn("[BundleManager] 启动更新检查失败，使用已安装构建", error);
      }
      this.offHello = client.subscribe("remote.hello", () =>
        this.requestCheck(),
      );
      window.addEventListener("classapp:update-check", this.onRequested);
      this.timer = setInterval(() => this.requestCheck(), 5 * 60_000);
    }
    return () => this.stop();
  }

  requestCheck(): void {
    void this.check().catch((error) => {
      console.warn("[BundleManager] 后台更新检查失败", error);
    });
  }

  private async check(): Promise<void> {
    if (this.checking || this.stopped || import.meta.env.DEV) return;
    this.checking = true;
    try {
      const manifest = await fetchManifest();
      const worker = await serviceWorker();
      if (manifest.buildId === this.currentBuildId) {
        await this.reconcileShell(worker, manifest);
        return;
      }

      const previousBundleBuildId = await activeBundleBuildId();
      const previousShellBuildId = await shellBuildId(worker);
      const [bundleBody, shellBlob] = await Promise.all([
        fetchAsset(manifest.bundle, "bundle"),
        fetchAsset(manifest.shell, "shell"),
      ]);
      const shellBody = await shellBlob.text();

      await stageBundle(manifest.buildId, bundleBody);
      await stageShell(worker, manifest.buildId, shellBody);
      try {
        await activateBundle(manifest.buildId);
        await activateShell(worker, manifest.buildId);
      } catch (error) {
        await Promise.allSettled([
          previousBundleBuildId
            ? activateBundle(previousBundleBuildId)
            : Promise.resolve(),
          previousShellBuildId
            ? activateShell(worker, previousShellBuildId)
            : Promise.resolve(),
        ]);
        throw error;
      }

      window.dispatchEvent(
        new CustomEvent("classapp:update-ready", {
          detail: { buildId: manifest.buildId },
        }),
      );
      window.location.reload();
      await new Promise<never>(() => {
        // Navigation owns completion once the unified build is activated.
      });
    } finally {
      this.checking = false;
    }
  }

  private async reconcileShell(
    worker: ServiceWorker | null,
    manifest: RuntimeManifest,
  ): Promise<void> {
    if (!worker || (await shellBuildId(worker)) === manifest.buildId) return;
    const body = await (await fetchAsset(manifest.shell, "shell")).text();
    await stageShell(worker, manifest.buildId, body);
    await activateShell(worker, manifest.buildId);
  }

  private stop(): void {
    this.stopped = true;
    this.offHello?.();
    if (this.timer) clearInterval(this.timer);
    window.removeEventListener("classapp:update-check", this.onRequested);
  }
}

export async function startBundleManager(
  currentBuildId: string,
): Promise<() => void> {
  return new BundleManager(currentBuildId).start();
}
