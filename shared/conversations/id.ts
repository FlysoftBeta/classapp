export type ConversationType = "group" | "dm";

export function groupConvId(groupId: string): string {
  return `group:${groupId}`;
}

export function orderedDmPeers(
  first: string,
  second: string,
): [string, string] {
  if (!first || !second || first === second) {
    throw new Error("A DM requires two distinct peer ids");
  }
  return first < second ? [first, second] : [second, first];
}

export function dmConvId(first: string, second: string): string {
  const [peerA, peerB] = orderedDmPeers(first, second);
  if (peerA.includes(":") || peerB.includes(":")) {
    throw new Error("User ids used in DM conversation ids cannot contain ':'");
  }
  return `dm:${peerA}:${peerB}`;
}

export function parseConvId(
  convId: string,
):
  | { type: "group"; groupId: string }
  | { type: "dm"; peerA: string; peerB: string }
  | null {
  if (convId.startsWith("group:")) {
    const groupId = convId.slice(6);
    return groupId ? { type: "group", groupId } : null;
  }
  if (!convId.startsWith("dm:")) return null;
  const peers = convId.slice(3).split(":");
  if (peers.length !== 2 || !peers[0] || !peers[1] || peers[0] >= peers[1]) {
    return null;
  }
  return { type: "dm", peerA: peers[0], peerB: peers[1] };
}

export function peerIdFromDmConvId(
  convId: string,
  currentUserId: string,
): string | null {
  const parsed = parseConvId(convId);
  if (!parsed || parsed.type !== "dm") return null;
  if (parsed.peerA === currentUserId) return parsed.peerB;
  if (parsed.peerB === currentUserId) return parsed.peerA;
  return null;
}
