import type { Assignment } from "@/client/repo/assignment";

export interface ReadWatermark {
  postId: string | null;
  sequence: number;
  timestamp: number;
}

/**
 * Grow-only watermark. Domain cursor wins; timestamps only break equal-cursor
 * ties. Resume is assignment and must not use this rule.
 */
export function chooseFurthestRead(
  local: ReadWatermark,
  remote: ReadWatermark,
): ReadWatermark {
  if (local.sequence !== remote.sequence) {
    return local.sequence > remote.sequence ? local : remote;
  }
  return local.timestamp > remote.timestamp ? local : remote;
}

export function chooseGrowOnlyCursor(
  local: { cursor: number; updatedAt: number },
  remote: { cursor: number; updatedAt: number },
): { cursor: number; updatedAt: number } {
  const winner = chooseFurthestRead(
    { postId: null, sequence: local.cursor, timestamp: local.updatedAt },
    { postId: null, sequence: remote.cursor, timestamp: remote.updatedAt },
  );
  return { cursor: winner.sequence, updatedAt: winner.timestamp };
}

/**
 * Whether a local read/furthest proposal survives an acknowledged remote
 * value. `furthest` compares domain cursors; `override` compares timestamps.
 */
export function keepWatermarkProposal<T>(input: {
  proposal: Assignment<T>["proposal"];
  remoteUpdatedAt: number;
  merge: "override" | "furthest";
  proposalCursor: number;
  remoteCursor: number;
}): Assignment<T>["proposal"] {
  const proposal = input.proposal;
  if (!proposal) return null;
  const keep =
    input.merge === "furthest"
      ? input.proposalCursor > input.remoteCursor
      : proposal.updated_at > input.remoteUpdatedAt;
  return keep ? proposal : null;
}
