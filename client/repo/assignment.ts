export interface AssignmentBase<T> {
  value: T;
  updated_at: number;
}

export interface AssignmentProposal<T> extends AssignmentBase<T> {
  operation_id: string;
}

export interface Assignment<T> {
  base: AssignmentBase<T>;
  proposal: AssignmentProposal<T> | null;
}

const DEFAULT_ASSIGNMENT_TIME = 0;

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

/**
 * Assignment (LWW): a canonical base plus at most one local proposal.
 * Equal timestamps drop the proposal so the canonical value wins.
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

export function nextDeviceTimestamp(previous = 0, now = Date.now()): number {
  return Assignments.nextTimestamp(previous, now);
}

/** Device-time LWW. Equal timestamps resolve to the remote/canonical value. */
export function chooseLww<T, Purpose extends string>(
  local: LwwProposal<T, Purpose> | null,
  remote: LwwProposal<T, Purpose>,
): LwwProposal<T, Purpose> {
  return local && local.timestamp > remote.timestamp ? local : remote;
}

export function statePending(state: object): 0 | 1 {
  return Object.values(state as Record<string, unknown>).some(
    (value) =>
      !!value &&
      typeof value === "object" &&
      "proposal" in value &&
      !!(value as { proposal?: unknown }).proposal,
  )
    ? 1
    : 0;
}
