import { Assignments, statePending, type Assignment } from "./assignment";

/**
 * Authoritative snapshot for one actor. Objective entities merge; that
 * actor's access membership is replaced; decision bases reconcile without
 * clearing a strictly newer proposal.
 */

export function mergeSnapshotAssignment<T>(
  current: Assignment<T> | null | undefined,
  remote: { value: T; updatedAt: number },
): Assignment<T> {
  return Assignments.reconcile(current ?? null, remote);
}

export function withPending<T extends object>(state: T): T & { pending: 0 | 1 } {
  return { ...state, pending: statePending(state) };
}
