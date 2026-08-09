/**
 * Client-side consistency primitives. Domain repositories use these rules;
 * UI code never compares timestamps or revisions itself.
 */

export interface LwwProposal<T, Purpose extends string = string> {
  proposed: T;
  purpose: Purpose;
  timestamp: number;
}

export interface StoredLww<
  T,
  Purpose extends string = string,
> extends LwwProposal<T, Purpose> {
  acknowledgedTimestamp: number | null;
}

export function nextDeviceTimestamp(previous = 0, now = Date.now()): number {
  return Math.max(now, previous + 1);
}

/** Device-time LWW. Equal timestamps resolve to the remote/canonical value. */
export function chooseLww<T, Purpose extends string>(
  local: LwwProposal<T, Purpose> | null,
  remote: LwwProposal<T, Purpose>,
): LwwProposal<T, Purpose> {
  return local && local.timestamp > remote.timestamp ? local : remote;
}

export interface ReadWatermark {
  postId: string | null;
  sequence: number;
  timestamp: number;
}

/** Read state is a grow-only watermark; wall clock only acknowledges ties. */
export function chooseFurthestRead(
  local: ReadWatermark,
  remote: ReadWatermark,
): ReadWatermark {
  if (local.sequence !== remote.sequence) {
    return local.sequence > remote.sequence ? local : remote;
  }
  return local.timestamp > remote.timestamp ? local : remote;
}

export interface ConversationRevision {
  conv_id: string;
  revision: number;
}

/** A stale page or event can never overwrite a newer current post row. */
export function choosePostVersion<T extends { revision: number }>(
  local: T | null,
  incoming: T,
): T {
  return local && local.revision > incoming.revision ? local : incoming;
}

/** Returns only conversations whose authoritative post revision advanced. */
export function changedConversationRevisions(
  local: Iterable<ConversationRevision>,
  remote: Iterable<ConversationRevision>,
): ConversationRevision[] {
  const known = new Map(
    Array.from(local, (entry) => [entry.conv_id, entry.revision]),
  );
  return Array.from(remote).filter(
    (entry) => entry.revision > (known.get(entry.conv_id) ?? 0),
  );
}

/** Stable keyset pull for one authoritative conversation revision snapshot. */
export async function collectRevisionRange<T extends { revision: number }>(
  afterRevision: number,
  throughRevision: number,
  fetchPage: (cursor: number, through: number, limit: number) => Promise<T[]>,
  pageSize = 200,
): Promise<T[]> {
  if (throughRevision <= afterRevision) return [];
  const rows: T[] = [];
  let cursor = afterRevision;
  while (true) {
    const page = await fetchPage(cursor, throughRevision, pageSize);
    rows.push(...page);
    if (page.length < pageSize) return rows;
    const nextCursor = Math.max(...page.map((row) => row.revision));
    if (nextCursor <= cursor) throw new Error("Revision page did not advance");
    cursor = nextCursor;
  }
}

/** Immutable entities may be cached repeatedly, but the same ID cannot change. */
export function assertImmutableEntity<T>(
  previous: T | null,
  incoming: T,
  identity: string,
): T {
  if (
    previous !== null &&
    JSON.stringify(previous) !== JSON.stringify(incoming)
  ) {
    throw new Error(`Immutable entity ${identity} changed`);
  }
  return previous ?? incoming;
}
