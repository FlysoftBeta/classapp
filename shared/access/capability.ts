/**
 * Capability tokens for ownerless objective resources.
 *
 * A snapshot (search or a containing collection) signs each contained object.
 * The server verifies the HMAC and expiry without storing the snapshot. Possession
 * of an unexpired token is authorization for `read` of that object.
 *
 * Collection `kind` is an opaque domain string (playlist, queue, booklist, …).
 * The access/capability layer does not enumerate those domains.
 */

export const CAPABILITY_VERSION = 1 as const;

export type CapabilitySource =
  | { readonly type: "search" }
  | {
      readonly type: "collection";
      readonly kind: string;
      readonly id: string;
      readonly revision?: number;
    }
  | {
      readonly type: "recovery";
      readonly kind: string;
      readonly id: string;
    };

export type CapabilityOp = "read";

export interface CapabilityPayload {
  readonly v: typeof CAPABILITY_VERSION;
  readonly kind: string;
  readonly id: string;
  readonly ops: readonly CapabilityOp[];
  readonly src: CapabilitySource;
  readonly iat: number;
  readonly exp: number;
}

export const SEARCH_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
export const LIST_CAPABILITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function collectionSource(
  kind: string,
  id: string,
  revision?: number,
): CapabilitySource {
  return revision === undefined
    ? { type: "collection", kind, id }
    : { type: "collection", kind, id, revision };
}

export function recoverySource(kind: string, id: string): CapabilitySource {
  return { type: "recovery", kind, id };
}

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
  if (source.type === "recovery") {
    return `recovery:${source.kind}:${source.id}`;
  }
  const revision =
    source.revision === undefined ? "" : `:${String(source.revision)}`;
  return `collection:${source.kind}:${source.id}${revision}`;
}

export function capabilitySourceId(source: CapabilitySource): string | null {
  return source.type === "search" ? null : source.id;
}

export function capabilitySourceKind(source: CapabilitySource): string {
  if (source.type === "search") return "search";
  if (source.type === "recovery") return `recovery:${source.kind}`;
  return source.kind;
}

export function capabilityAllowsRead(payload: CapabilityPayload): boolean {
  return payload.ops.indexOf("read") !== -1;
}
