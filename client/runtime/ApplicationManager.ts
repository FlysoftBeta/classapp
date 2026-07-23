import { client } from "@/client/remote/Client";

interface AppManifest {
  buildId: string;
  bundle: string;
  size: number;
}

/**
 * Blocks production startup until the current build has been checked.
 * When an update exists, the old application never starts: the new bundle is
 * committed to IndexedDB and activated before reloading into Shell.
 */
export async function startApplicationManager(
  currentBuildId: string,
): Promise<() => void> {
  let checking = false;
  const check = async () => {
    if (checking || import.meta.env.DEV) return;
    checking = true;
    try {
      const manifest = (await fetch("/app/manifest.json", {
        cache: "no-store",
      }).then((response) => {
        if (!response.ok) throw new Error(`manifest ${response.status}`);
        return response.json();
      })) as AppManifest;
      if (!manifest.buildId || manifest.buildId === currentBuildId) return;
      const body = await fetch(manifest.bundle, { cache: "no-store" }).then(
        (r) => {
          if (!r.ok) throw new Error(`bundle ${r.status}`);
          return r.blob();
        },
      );
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("classapp-runtime", 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("bundles")) {
            database.createObjectStore("bundles", { keyPath: "buildId" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("bundles", "readwrite");
        tx.objectStore("bundles").put({
          buildId: manifest.buildId,
          body,
          installedAt: Date.now(),
          active: true,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      localStorage.setItem("classapp-active-build", manifest.buildId);
      window.dispatchEvent(
        new CustomEvent("classapp:update-ready", {
          detail: { buildId: manifest.buildId },
        }),
      );
      window.location.reload();
      await new Promise<never>(() => {
        // Keep the stale application blocked until navigation tears it down.
      });
    } finally {
      checking = false;
    }
  };

  // A failed check preserves offline startup. A detected update, however,
  // never resolves because the stale application must not issue requests.
  try {
    await check();
  } catch (error) {
    console.warn("[ApplicationManager] 启动版本检查失败，使用已安装版本", error);
  }

  const scheduleCheck = () => {
    void check().catch((error) => {
      console.warn("[ApplicationManager] 后台版本检查失败", error);
    });
  };
  const offHello = client.subscribe("remote.hello", scheduleCheck);
  const timer = setInterval(scheduleCheck, 5 * 60_000);
  return () => {
    offHello();
    clearInterval(timer);
  };
}
