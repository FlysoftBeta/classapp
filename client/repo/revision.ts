/**
 * Revisioned current state. A stale page or event cannot overwrite a newer
 * row; equal-revision content disagreement is a contract violation.
 */

export interface ConversationRevision {
  conv_id: string;
  revision: number;
}

export function choosePostVersion<T extends { revision: number }>(
  local: T | null,
  incoming: T,
): T {
  return local && local.revision > incoming.revision ? local : incoming;
}

export function mergeRevisionedIdentity<T extends { revision: number }>(input: {
  current: T | null | undefined;
  incoming: T;
  unversionedRevision?: number;
  sameContent: boolean;
  identity: string;
}): T | "keep" {
  const current = input.current;
  const currentRevision =
    current?.revision ?? input.unversionedRevision ?? -1;
  if (current && input.incoming.revision < currentRevision) return "keep";
  if (current && input.incoming.revision === currentRevision && !input.sameContent) {
    throw new Error(`User metadata revision collision: ${input.identity}`);
  }
  return input.incoming;
}

export function decideRevisionedWrite<T extends { revision: number }>(input: {
  previous: T | null | undefined;
  incoming: T;
  sameContent: boolean;
  identity: string;
  collisionLabel: string;
}): "skip" | "put" {
  const previous = input.previous;
  if (previous && previous.revision > input.incoming.revision) return "skip";
  if (previous && previous.revision === input.incoming.revision && !input.sameContent) {
    throw new Error(`${input.collisionLabel}: ${input.identity}`);
  }
  return "put";
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
  if (pageSize < 1) throw new Error("Revision page size must be positive");
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
