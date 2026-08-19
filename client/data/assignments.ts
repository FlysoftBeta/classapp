import type { Assignment } from "./model";

const DEFAULT_ASSIGNMENT_TIME = 0;

/**
 * Offline assignment algebra: a canonical base plus at most one local
 * proposal. UI and repositories use these rules; they never compare
 * timestamps themselves.
 */
export class Assignments {
  static size(value: unknown): number {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Cannot size non-JSON value");
    return new TextEncoder().encode(encoded).byteLength;
  }

  static equal(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  /** Monotonic device time; equal wall clocks still advance by one millisecond. */
  static nextTimestamp(previous = 0, now = Date.now()): number {
    return Math.max(now, previous + 1);
  }

  static assignment<T>(value: T, updatedAt = 0): Assignment<T> {
    return {
      base: { value, updated_at: updatedAt },
      proposal: null,
    };
  }

  static resolved<T>(assignment: Assignment<T>): {
    value: T;
    updatedAt: number;
    pending: boolean;
  } {
    const proposal = assignment.proposal;
    if (proposal && proposal.updated_at > assignment.base.updated_at) {
      return {
        value: proposal.value,
        updatedAt: proposal.updated_at,
        pending: true,
      };
    }
    return {
      value: assignment.base.value,
      updatedAt: assignment.base.updated_at,
      pending: false,
    };
  }

  /** Equal timestamps drop the local proposal so the canonical value wins. */
  static reconcile<T>(
    current: Assignment<T> | null,
    remote: { value: T; updatedAt: number },
  ): Assignment<T> {
    const base = { value: remote.value, updated_at: remote.updatedAt };
    if (!current?.proposal || current.proposal.updated_at <= remote.updatedAt) {
      return { base, proposal: null };
    }
    return { base, proposal: current.proposal };
  }

  static propose<T>(
    current: Assignment<T> | null,
    value: T,
    updatedAt?: number,
    now = Date.now(),
  ): Assignment<T> {
    const previous = current
      ? Math.max(
          current.base.updated_at,
          current.proposal?.updated_at ?? DEFAULT_ASSIGNMENT_TIME,
        )
      : DEFAULT_ASSIGNMENT_TIME;
    const stamp = updatedAt ?? Assignments.nextTimestamp(previous, now);
    return {
      base: current?.base ?? { value, updated_at: 0 },
      proposal: {
        value,
        updated_at: stamp,
        operation_id: `${stamp.toString(36)}-${Math.random().toString(36).slice(2)}`,
      },
    };
  }
}
