/**
 * Access grants for owned resources (playlists, booklists, queues).
 *
 * A binding is (resource × principal) and stores a normalized *set* of issued
 * grants, not an addressable access object. Effective authority is the union of
 * flags from every live path (direct user binding plus each group the user
 * belongs to). Issuing a grant to another principal is allowed only from the
 * shareable *portion* of that union.
 */

export type AccessMode = "owner" | "readwrite" | "read";

export type AccessGrant =
  | { readonly mode: "owner" }
  | { readonly mode: "readwrite" | "read"; readonly shareable: boolean };

export type AccessNeed =
  | "read"
  | "write"
  | "own"
  | { readonly share: AccessGrant };

export interface AccessFlags {
  readonly read: boolean;
  readonly write: boolean;
  readonly own: boolean;
  readonly shareRead: boolean;
  readonly shareWrite: boolean;
  readonly shareOwn: boolean;
}

export const EMPTY_ACCESS_FLAGS: AccessFlags = {
  read: false,
  write: false,
  own: false,
  shareRead: false,
  shareWrite: false,
  shareOwn: false,
};

export const OWNER_ACCESS_FLAGS: AccessFlags = {
  read: true,
  write: true,
  own: true,
  shareRead: true,
  shareWrite: true,
  shareOwn: true,
};

export function flagsOf(grant: AccessGrant): AccessFlags {
  if (grant.mode === "owner") return OWNER_ACCESS_FLAGS;
  return {
    read: true,
    write: grant.mode === "readwrite",
    own: false,
    shareRead: grant.shareable,
    shareWrite: grant.shareable && grant.mode === "readwrite",
    shareOwn: false,
  };
}

export function unionFlags(left: AccessFlags, right: AccessFlags): AccessFlags {
  return {
    read: left.read || right.read,
    write: left.write || right.write,
    own: left.own || right.own,
    shareRead: left.shareRead || right.shareRead,
    shareWrite: left.shareWrite || right.shareWrite,
    shareOwn: left.shareOwn || right.shareOwn,
  };
}

export function unionFlagList(list: readonly AccessFlags[]): AccessFlags {
  let result = EMPTY_ACCESS_FLAGS;
  for (const flags of list) result = unionFlags(result, flags);
  return result;
}

/** True iff every set flag in `inner` is also set on `outer`. */
export function flagsCover(outer: AccessFlags, inner: AccessFlags): boolean {
  return (
    (!inner.read || outer.read) &&
    (!inner.write || outer.write) &&
    (!inner.own || outer.own) &&
    (!inner.shareRead || outer.shareRead) &&
    (!inner.shareWrite || outer.shareWrite) &&
    (!inner.shareOwn || outer.shareOwn)
  );
}

export function flagsEqual(left: AccessFlags, right: AccessFlags): boolean {
  return (
    left.read === right.read &&
    left.write === right.write &&
    left.own === right.own &&
    left.shareRead === right.shareRead &&
    left.shareWrite === right.shareWrite &&
    left.shareOwn === right.shareOwn
  );
}

/**
 * Holder of `source` may issue `derived` to another principal.
 * Owner may issue any grant. A non-owner grant may issue only when it is
 * shareable, and only a restriction of its own mode.
 */
export function canIssueGrant(
  source: AccessGrant,
  derived: AccessGrant,
): boolean {
  if (source.mode === "owner") return true;
  if (!source.shareable) return false;
  if (derived.mode === "owner") return false;
  if (derived.mode === "readwrite" && source.mode !== "readwrite") return false;
  return true;
}

/** `derived` is an issuable subset of `source` (same relation as canIssueGrant). */
export function isSubsetGrant(
  derived: AccessGrant,
  source: AccessGrant,
): boolean {
  return canIssueGrant(source, derived);
}

/**
 * Effective flags may issue `derived` only from the matching shareable portion.
 * Write-without-share does not authorize granting write to others.
 */
export function flagsCanIssue(
  flags: AccessFlags,
  derived: AccessGrant,
): boolean {
  if (derived.mode === "owner") return flags.shareOwn;
  if (derived.mode === "readwrite") return flags.shareWrite;
  return flags.shareRead;
}

export function flagsSatisfy(flags: AccessFlags, need: AccessNeed): boolean {
  if (need === "read") return flags.read;
  if (need === "write") return flags.write;
  if (need === "own") return flags.own;
  return flagsCanIssue(flags, need.share);
}

export function grantsEqual(left: AccessGrant, right: AccessGrant): boolean {
  if (left.mode === "owner") return right.mode === "owner";
  return (
    right.mode !== "owner" &&
    left.mode === right.mode &&
    left.shareable === right.shareable
  );
}

export function grantKey(grant: AccessGrant): string {
  if (grant.mode === "owner") return "owner";
  return `${grant.mode}:${grant.shareable ? "share" : "held"}`;
}

/**
 * `source` dominates `other` when its flags cover the other grant. Used to
 * prune a principal's grant set; it is not the issuing relation.
 */
export function grantDominates(
  source: AccessGrant,
  other: AccessGrant,
): boolean {
  return flagsCover(flagsOf(source), flagsOf(other));
}

/**
 * Keep incomparable grants; drop any grant whose flags are covered by another.
 * Owner collapses the set. Order is stable by grantKey.
 */
export function normalizeGrantSet(
  grants: readonly AccessGrant[],
): AccessGrant[] {
  const unique: AccessGrant[] = [];
  for (const grant of grants) {
    if (!unique.some((existing) => grantsEqual(existing, grant))) {
      unique.push(grant);
    }
  }
  if (unique.some((grant) => grant.mode === "owner")) {
    return [{ mode: "owner" }];
  }
  const kept = unique.filter(
    (grant) =>
      !unique.some(
        (other) =>
          !grantsEqual(other, grant) && grantDominates(other, grant),
      ),
  );
  kept.sort((left, right) => grantKey(left).localeCompare(grantKey(right)));
  return kept;
}

export function flagsOfGrantSet(grants: readonly AccessGrant[]): AccessFlags {
  return unionFlagList(normalizeGrantSet(grants).map(flagsOf));
}

/** Insert `incoming` into a principal's grant set without privilege escalation. */
export function mergeIncomingGrant(
  existing: readonly AccessGrant[],
  incoming: AccessGrant,
): AccessGrant[] {
  return normalizeGrantSet([...existing, incoming]);
}

export const ALL_ACCESS_GRANTS: readonly AccessGrant[] = [
  { mode: "owner" },
  { mode: "readwrite", shareable: true },
  { mode: "readwrite", shareable: false },
  { mode: "read", shareable: true },
  { mode: "read", shareable: false },
];
