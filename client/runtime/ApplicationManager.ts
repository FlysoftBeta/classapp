import { client } from "@/client/remote/Client";

interface AppManifest {
  buildId: string;
  bundle: string;
  size: number;
}

/** Downloads an update into IndexedDB; Shell activates it on the next reload. */
export function startApplicationManager(currentBuildId: string): () => void {
  let checking = false;
  const check = async () => {
    if (checking || import.meta.env.DEV) return;
    checking = true;
    try {
      const manifest = (await fetch("/app/manifest.json", {
        cache: "no-store",
      }).then((response) => response.json())) as AppManifest;
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
    } finally {
      checking = false;
    }
  };
  const offHello = client.subscribe("remote.hello", check);
  const timer = setInterval(check, 5 * 60_000);
  void check();
  return () => {
    offHello();
    clearInterval(timer);
  };
}
