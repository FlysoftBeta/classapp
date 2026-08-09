import { client } from "@/client/interact/remote/client";
import { requestResult, runTransaction } from "@/client/data/idb";
import { GLOBAL_KEYS, STORES } from "@/client/data/schema";
import {
  type RuntimeAsset,
  type RuntimeManifest,
} from "@/shared/runtimeManifest";
import { ensureEndpointsReady, lbAssetUrl } from "./loadBalancer";

type WorkerReply = {
  ok: boolean;
  buildId?: string | null;
  error?: string;
};

async function fetchManifest(): Promise<RuntimeManifest> {
  const response = await fetch("/app/manifest.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`manifest ${response.status}`);
  return (await response.json()) as RuntimeManifest;
}

async function fetchAsset(
  asset: RuntimeAsset,
  label: string,
): Promise<ArrayBuffer> {
  const response = await fetch(asset.url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${label} ${response.status}`);
  const body = await response.arrayBuffer();
  if (body.byteLength !== asset.size) {
    throw new Error(
      `${label} size mismatch: ${body.byteLength} != ${asset.size}`,
    );
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

async function stageBundle(buildId: string, body: ArrayBuffer): Promise<void> {
  await runTransaction(STORES.BUNDLES, "readwrite", (tx) => {
    tx.objectStore(STORES.BUNDLES).put({
      build_id: buildId,
      entrypoint_code: body,
      installed_at: Date.now(),
    });
  });
}

async function activateBundle(buildId: string): Promise<void> {
  await runTransaction(
    [STORES.BUNDLES, STORES.GLOBALS],
    "readwrite",
    async (tx) => {
      const bundle = await requestResult(
        tx.objectStore(STORES.BUNDLES).get(buildId),
      );
      if (!bundle) throw new Error(`Cannot activate missing bundle ${buildId}`);
      tx.objectStore(STORES.GLOBALS).put({
        key: GLOBAL_KEYS.ACTIVE_BUNDLE,
        value: buildId,
      });
    },
  );
}

async function activeBundleBuildId(): Promise<string | null> {
  return runTransaction(STORES.GLOBALS, "readonly", async (tx) => {
    const record = (await requestResult(
      tx.objectStore(STORES.GLOBALS).get(GLOBAL_KEYS.ACTIVE_BUNDLE),
    )) as { value?: unknown } | undefined;
    return typeof record?.value === "string" ? record.value : null;
  });
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

  constructor(
    private readonly currentBuildId: string,
    private readonly onManifest: (manifest: RuntimeManifest) => void,
  ) {}

  async start(): Promise<() => void> {
    try {
      await this.check();
    } catch (error) {
      console.warn("[BundleManager] 启动更新检查失败，使用已安装构建", error);
    }
    this.offHello = client.subscribe("remote.hello", () => this.requestCheck());
    window.addEventListener("classapp:update-check", this.onRequested);
    this.timer = setInterval(() => this.requestCheck(), 5 * 60_000);

    return () => this.stop();
  }

  requestCheck(): void {
    void this.check().catch((error) => {
      console.warn("[BundleManager] 后台更新检查失败", error);
    });
  }

  private async check(): Promise<void> {
    if (this.checking || this.stopped) return;
    this.checking = true;
    try {
      const manifest = await fetchManifest();
      this.onManifest(manifest);

      if (!import.meta.env.DEV) {
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
        const shellBody = new TextDecoder().decode(shellBlob);

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
      }
    } finally {
      this.checking = false;
    }
  }

  private async reconcileShell(
    worker: ServiceWorker | null,
    manifest: RuntimeManifest,
  ): Promise<void> {
    if (!worker || (await shellBuildId(worker)) === manifest.buildId) return;
    const body = new TextDecoder().decode(
      await fetchAsset(manifest.shell, "shell"),
    );
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
  onManifest: (manifest: RuntimeManifest) => void,
): Promise<() => void> {
  return new BundleManager(currentBuildId, onManifest).start();
}
