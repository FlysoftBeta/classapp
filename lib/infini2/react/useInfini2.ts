import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  Infini2Controller,
  type Infini2ControllerConfig,
  type Infini2Id,
} from "../data";

/**
 * Owns one controller for the mounted component lifetime and observes its state.
 *
 * @param config - Initial immutable controller configuration. Later render-time
 * object changes do not recreate or reconfigure the controller.
 * @returns Stable `controller` plus its current immutable `snapshot`.
 * @remarks The controller starts after mount. Cleanup is microtask-guarded so
 * React StrictMode's immediate effect replay does not destroy the live instance.
 */
export function useInfini2<
  TItem,
  TCursor,
  TId extends Infini2Id,
  TTarget = never,
>(config: Infini2ControllerConfig<TItem, TCursor, TId, TTarget>) {
  const lifecycle = useRef(0);
  const [controller] = useState(
    () => new Infini2Controller<TItem, TCursor, TId, TTarget>(config),
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    lifecycle.current += 1;
    controller.start();
    return () => {
      const cleanup = ++lifecycle.current;
      queueMicrotask(() => {
        // React StrictMode immediately replays effects. Dispose only if no
        // replacement setup occurred before this microtask checkpoint.
        if (lifecycle.current === cleanup) controller.dispose();
      });
    };
  }, [controller]);
  return { controller, snapshot } as const;
}
