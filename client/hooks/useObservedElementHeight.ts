import { useCallback, useLayoutEffect, useState } from "react";

/** Measures an element's border-box height and follows later layout changes. */
export function useObservedElementHeight<TElement extends HTMLElement>() {
  const [node, setNode] = useState<TElement | null>(null);
  const [height, setHeight] = useState(0);

  const ref = useCallback((nextNode: TElement | null) => {
    setNode(nextNode);
    setHeight(nextNode?.getBoundingClientRect().height ?? 0);
  }, []);

  useLayoutEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const nextHeight = node.getBoundingClientRect().height;
      setHeight((previous) =>
        Math.abs(previous - nextHeight) < 0.5 ? previous : nextHeight,
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [ref, height] as const;
}
