import { Assignments } from "./assignment";

/** Immutable entities may be cached repeatedly, but the same ID cannot change. */
export function assertImmutableEntity<T>(
  previous: T | null,
  incoming: T,
  identity: string,
): T {
  if (previous !== null && !Assignments.equal(previous, incoming)) {
    throw new Error(`Immutable entity ${identity} changed`);
  }
  return previous ?? incoming;
}

export function assertImmutableStored<T>(
  previous: T | undefined,
  incoming: T,
  identity: string,
): void {
  if (previous === undefined) return;
  assertImmutableEntity(previous, incoming, identity);
}
