import { lbFetchUrl } from "@/client/lib/loadBalancer";
import { session } from "@/client/lib/remote/session";
import { transport } from "@/client/lib/remote/transport";
import type { ActionResult } from "@/shared/protocol/result";

type RuntimeConfig = {
  buildId: string;
};

let _buildReloadPending = false;
let _runtime: RuntimeConfig = { buildId: "dev" };

export function configureClientRuntime(runtime: RuntimeConfig): void {
  _runtime = runtime;
}

function reloadOnBuildMismatch(res: Response): void {
  const serverBuildId = res.headers.get("x-build-id");
  if (
    !serverBuildId ||
    serverBuildId === _runtime.buildId ||
    _buildReloadPending
  ) {
    return;
  }
  _buildReloadPending = true;
  window.location.reload();
}

export async function apiFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (transport.isForcedOffline()) {
    throw new TypeError("已强制切换到离线模式");
  }
  const res = await fetch(lbFetchUrl(url), init);
  reloadOnBuildMismatch(res);

  if (res.status === 401) {
    try {
      const clone = res.clone();
      const data = await clone.json();
      if (data?.client_invalid) {
        session.invalidate();
      }
    } catch {
      // ignore JSON parse errors
    }
  }

  return res;
}

export function authHeaders(token?: string): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function parseJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

export function applyActionResultMeta<T>(result: ActionResult<T>): void {
  if (
    result.meta.buildId &&
    result.meta.buildId !== _runtime.buildId &&
    !_buildReloadPending
  ) {
    _buildReloadPending = true;
    window.location.reload();
    return;
  }
}

/** Observe global metadata while preserving the Rust-like Result unchanged. */
export function observeActionResult<T>(
  result: ActionResult<T>,
): ActionResult<T> {
  applyActionResultMeta(result);
  return result;
}
