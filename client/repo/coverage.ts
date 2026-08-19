/**
 * Coverage: a rooted continuous interval proven by authoritative pagination.
 *
 * Posts and article lists use this model. Isolated pages and event overlays
 * may exist outside the published interval; they do not widen it.
 */

export interface CoverageBoundary {
  id: string;
  order: string | number;
}

/** A proof that every row between newest and oldest has been observed. */
export interface ContinuousCoverage<B extends CoverageBoundary> {
  newest: B;
  oldest: B;
  reached_newest: boolean;
  reached_oldest: boolean;
}

export interface PostWindowCoverage extends ContinuousCoverage<{
  id: string;
  order: number;
}> {
  known_revision: number;
  revision_sum: string;
}

function sameBoundary<B extends CoverageBoundary>(
  left: B | null | undefined,
  right: B | null | undefined,
): boolean {
  return (
    !!left && !!right && left.id === right.id && left.order === right.order
  );
}

export function mergeCursorCoverage<B extends CoverageBoundary>(input: {
  current: ContinuousCoverage<B> | null;
  direction: "before" | "after";
  cursor: B | null;
  first: B | null;
  last: B | null;
  exhausted: boolean;
}): ContinuousCoverage<B> | null {
  if (!input.first || !input.last) {
    // An empty page cannot publish an interval. It may still prove that a
    // connected cursor has reached an end of the collection.
    if (!input.cursor || !input.current || !input.exhausted) {
      return input.current;
    }
    if (
      input.direction === "after" &&
      sameBoundary(input.current.oldest, input.cursor)
    ) {
      return { ...input.current, reached_oldest: true };
    }
    if (
      input.direction === "before" &&
      sameBoundary(input.current.newest, input.cursor)
    ) {
      return { ...input.current, reached_newest: true };
    }
    return input.current;
  }
  if (!input.cursor) {
    // A root response starts a new proof. Older cached rows are no longer
    // claimed by this interval until a connected page reaches them again.
    return {
      newest: input.first,
      oldest: input.last,
      reached_newest: input.direction === "after" || input.exhausted,
      reached_oldest: input.direction === "before" || input.exhausted,
    };
  }
  const current = input.current;
  if (!current) return null;
  if (
    input.direction === "after" &&
    sameBoundary(current.oldest, input.cursor)
  ) {
    return {
      ...current,
      oldest: input.last,
      reached_oldest: current.reached_oldest || input.exhausted,
    };
  }
  if (
    input.direction === "before" &&
    sameBoundary(current.newest, input.cursor)
  ) {
    return {
      ...current,
      newest: input.first,
      reached_newest: current.reached_newest || input.exhausted,
    };
  }
  return null;
}

export function shouldExtendPostCoverage(input: {
  current: PostWindowCoverage | null | undefined;
  extendCoverage?: boolean;
  liveAppend?: boolean;
  incomingSequences: number[];
}): boolean {
  if (input.extendCoverage === true) return true;
  if (input.liveAppend !== true) return false;
  const current = input.current;
  return (
    !current ||
    (current.reached_newest &&
      !!current.newest &&
      input.incomingSequences.every((sequence) => sequence > current.newest.order))
  );
}

export function postIsInsidePublishedWindow(
  coverage: PostWindowCoverage | null | undefined,
  sequence: number,
): boolean {
  return (
    !!coverage?.oldest &&
    !!coverage.newest &&
    sequence >= coverage.oldest.order &&
    sequence <= coverage.newest.order
  );
}

/** A disconnected cursor page cannot establish or widen coverage. */
export type PostPageConnection = "ignore" | "apply" | "replace-window";

export function connectPostPage(input: {
  hasCoverage: boolean;
  cursorId: string | undefined;
  cursorInConversation: boolean;
  incomingOverlapsExisting: boolean;
}): PostPageConnection {
  if (!input.hasCoverage && !input.cursorId) return "apply";
  if (input.hasCoverage && input.cursorId) {
    return input.cursorInConversation ? "apply" : "ignore";
  }
  if (input.hasCoverage && !input.cursorId) {
    return input.incomingOverlapsExisting ? "apply" : "replace-window";
  }
  return "ignore";
}

export function nextPostWindowCoverage(input: {
  current: PostWindowCoverage | null | undefined;
  written: Array<{ id: string; sequence: number }>;
  reachedOldest?: boolean;
  reachedNewest?: boolean;
}): PostWindowCoverage | null {
  if (!input.written.length) return null;
  let oldest = input.written[0];
  let newest = input.written[0];
  for (const row of input.written) {
    if (row.sequence < oldest.sequence) oldest = row;
    if (row.sequence > newest.sequence) newest = row;
  }
  const writtenOldest = { id: oldest.id, order: oldest.sequence };
  const writtenNewest = { id: newest.id, order: newest.sequence };
  const current = input.current;
  return {
    oldest:
      !current?.oldest || writtenOldest.order < current.oldest.order
        ? writtenOldest
        : current.oldest,
    newest:
      !current?.newest || writtenNewest.order > current.newest.order
        ? writtenNewest
        : current.newest,
    reached_oldest: (current?.reached_oldest ?? false) || !!input.reachedOldest,
    reached_newest: (current?.reached_newest ?? false) || !!input.reachedNewest,
    known_revision: current?.known_revision ?? 0,
    revision_sum: current?.revision_sum ?? "0",
  };
}

/**
 * Empty coverage is absent. Prefix deletion always drops reached_oldest
 * because the new lower bound was not proven by pagination.
 */
export function postCoverageAfterPrefixDelete<C extends PostWindowCoverage>(
  current: C | null | undefined,
  retained: Array<{ id: string; sequence: number }>,
): C | "delete" | "unchanged" {
  if (!current) return "unchanged";
  if (!retained.length) return "delete";
  const first = retained[0];
  const last = retained[retained.length - 1];
  return {
    ...current,
    oldest: { id: first.id, order: first.sequence },
    newest: { id: last.id, order: last.sequence },
    reached_oldest: false,
  };
}

export function mergeArticleListMemberships<
  M extends { view: string; group_id: string | null; sort_at: string },
>(current: M[] | undefined, incoming: M): M[] {
  const memberships = (current ?? []).filter(
    (item) => item.view !== incoming.view || item.group_id !== incoming.group_id,
  );
  memberships.push(incoming);
  return memberships;
}

export function articleListRootMemberships<
  M extends { view: string; group_id: string | null },
  R extends { object_id: string; memberships: M[] },
>(input: {
  rows: R[];
  pageIds: ReadonlySet<string>;
  view: M["view"];
  groupId: string | null;
}): { put: R[]; remove: R[] } {
  const put: R[] = [];
  const remove: R[] = [];
  for (const row of input.rows) {
    if (input.pageIds.has(row.object_id)) continue;
    const memberships = row.memberships.filter(
      (membership) =>
        membership.view !== input.view || membership.group_id !== input.groupId,
    );
    if (memberships.length) {
      put.push({ ...row, memberships });
    } else {
      remove.push(row);
    }
  }
  return { put, remove };
}
