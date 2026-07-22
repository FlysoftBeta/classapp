let fetchOriginCursor = 0;
let endpoints: readonly string[] | null = null;
let endpointsPromise: Promise<void> | null = null;

function pageOrigin(): string {
  if (typeof window === "undefined") return "http://localhost";
  return window.location.origin;
}

function getEndpoints(): readonly string[] {
  if (endpoints && endpoints.length > 0) return endpoints;
  return [pageOrigin()];
}

/** Fetch API origins from the page origin before spreading requests. */
export async function ensureEndpointsReady(): Promise<void> {
  if (endpoints !== null) return;
  if (endpointsPromise) return endpointsPromise;

  endpointsPromise = (async () => {
    try {
      const res = await fetch(`${window.location.origin}/api/endpoints`);
      if (res.ok) {
        const data = (await res.json()) as { origins?: unknown };
        if (Array.isArray(data.origins)) {
          const origins = data.origins.filter(
            (o): o is string => typeof o === "string" && o.length > 0,
          );
          if (origins.length > 0) {
            endpoints = origins;
            return;
          }
        }
      }
    } catch {
      /* fall back to current page origin */
    }
    endpoints = [pageOrigin()];
  })();

  return endpointsPromise;
}

function spreadEnabled(): boolean {
  return getEndpoints().length > 1;
}

/** Round-robin origin for concurrent fetch requests (apiFetch). */
function nextFetchOrigin(): string {
  const list = getEndpoints();
  if (list.length <= 1) return list[0] ?? pageOrigin();
  const origin = list[fetchOriginCursor % list.length];
  fetchOriginCursor++;
  return origin;
}

/** Stable origin per path so <img> src does not change across re-renders. */
function originForAsset(path: string): string {
  const list = getEndpoints();
  if (list.length <= 1) return list[0] ?? pageOrigin();
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = (hash + path.charCodeAt(i)) | 0;
  }
  return list[Math.abs(hash) % list.length];
}

function rewritePath(path: string, origin: string): string {
  if (!spreadEnabled() || typeof window === "undefined") return path;
  return `${origin}${path}`;
}

/** Spread apiFetch across API origins. Skips absolute and non-HTTP URLs. */
export function lbFetchUrl(url: string): string {
  if (!spreadEnabled() || typeof window === "undefined") return url;
  if (!url.startsWith("/")) return url;
  return rewritePath(url, nextFetchOrigin());
}

/** Spread static asset requests (stickers, etc.) across API origins. */
export function lbAssetUrl(path: string): string {
  if (!path.startsWith("/")) return path;
  return rewritePath(path, originForAsset(path));
}
