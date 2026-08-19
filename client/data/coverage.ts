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
