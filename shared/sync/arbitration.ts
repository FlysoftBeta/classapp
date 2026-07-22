export interface TimestampedValue<T> {
  value: T;
  updatedAt: number;
}

/** Server/canonical candidate wins an exact timestamp tie. */
export function chooseLatestTimestamped<
  T,
  L extends TimestampedValue<T>,
  R extends TimestampedValue<T>,
>(local: L | null, remote: R): L | R {
  return local && local.updatedAt > remote.updatedAt ? local : remote;
}

export interface OrderedReadValue {
  postId: string | null;
  sequence: number;
  updatedAt: number;
}

/** Conversation read position is monotonic; timestamps never beat sequence. */
export function chooseFurthestRead<
  L extends OrderedReadValue,
  R extends OrderedReadValue,
>(local: L, incoming: R): L | R {
  return local.sequence >= incoming.sequence ? local : incoming;
}
