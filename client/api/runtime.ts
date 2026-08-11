import { lbFetchUrl } from "@/client/lib/loadBalancer";
import { transport } from "@/client/interact/remote/transport";
import type { ActionResult } from "@/shared/protocol/result";

type RuntimeConfig = {
  buildId: string;
  debugMenu: boolean;
};

let _buildCheckPending = false;
let _runtime: RuntimeConfig = { buildId: "dev", debugMenu: false };

export function configureClientRuntime(runtime: RuntimeConfig): void {
  _runtime = runtime;
}

export function isDebugMenuEnabled(): boolean {
  return _runtime.debugMenu;
}

export function clientBuildId(): string {
  return _runtime.buildId;
}

function checkOnBuildMismatch(res: Response): void {
  const serverBuildId = res.headers.get("x-build-id");
  if (
    !serverBuildId ||
    serverBuildId === _runtime.buildId ||
    _buildCheckPending
  ) {
    return;
  }
  _buildCheckPending = true;
  window.dispatchEvent(new CustomEvent("classapp:update-check"));
  setTimeout(() => {
    _buildCheckPending = false;
  }, 10_000);
}

export async function apiFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (transport.isForcedOffline()) {
    throw new TypeError("已强制切换到离线模式");
  }
  const res = await fetch(lbFetchUrl(url), init);
  checkOnBuildMismatch(res);

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
    !_buildCheckPending
  ) {
    _buildCheckPending = true;
    window.dispatchEvent(new CustomEvent("classapp:update-check"));
    setTimeout(() => {
      _buildCheckPending = false;
    }, 10_000);
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
