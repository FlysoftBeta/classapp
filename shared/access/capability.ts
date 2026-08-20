/**
 * Capability tokens for ownerless objective resources (tracks, articles).
 *
 * A snapshot (search, queue, playlist, booklist) signs each contained object.
 * The server verifies the HMAC and expiry without storing the snapshot. Possession
 * of an unexpired token is authorization for `read` of that object.
 */

export const CAPABILITY_VERSION = 1 as const;

export type OwnerlessKind = "track" | "article";

export type CapabilitySource =
  | { readonly type: "search" }
  | { readonly type: "queue"; readonly list_id: string }
  | {
      readonly type: "playlist";
      readonly list_id: string;
      readonly revision: number;
    }
  | {
      readonly type: "booklist";
      readonly list_id: string;
      readonly revision: number;
    }
  | {
      readonly type: "recovery";
      readonly via: "queue" | "playlist" | "booklist";
      readonly list_id: string;
    };

export type CapabilityOp = "read";

export interface CapabilityPayload {
  readonly v: typeof CAPABILITY_VERSION;
  readonly kind: OwnerlessKind;
  readonly id: string;
  readonly ops: readonly CapabilityOp[];
  readonly src: CapabilitySource;
  readonly iat: number;
  readonly exp: number;
}

export const SEARCH_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
export const LIST_CAPABILITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function capabilitySigningInput(payload: CapabilityPayload): string {
  return [
    String(payload.v),
    payload.kind,
    payload.id,
    payload.ops.join(","),
    String(payload.iat),
    String(payload.exp),
    stableSource(payload.src),
  ].join("\n");
}

function stableSource(source: CapabilitySource): string {
  if (source.type === "search") return "search";
  if (source.type === "queue") return `queue:${source.list_id}`;
  if (source.type === "recovery") {
    return `recovery:${source.via}:${source.list_id}`;
  }
  return `${source.type}:${source.list_id}:${source.revision}`;
}

export function capabilityAllowsRead(payload: CapabilityPayload): boolean {
  return payload.ops.indexOf("read") !== -1;
}
