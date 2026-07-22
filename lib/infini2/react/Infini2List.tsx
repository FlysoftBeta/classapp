import {
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type { Infini2Controller, Infini2Id } from "../data";
import { Infini2DomHost } from "../dom";

interface PortalSlot<TItem, TId extends Infini2Id> {
  handle: number;
  id: TId;
  item: TItem;
  node: HTMLDivElement;
}

class PortalStore<TItem, TId extends Infini2Id> {
  private readonly slots = new Map<number, PortalSlot<TItem, TId>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.version;

  values(): PortalSlot<TItem, TId>[] {
    return [...this.slots.values()];
  }

  set(slot: PortalSlot<TItem, TId>): void {
    this.slots.set(slot.handle, slot);
    this.emit();
  }

  update(handle: number, item: TItem, id: TId): void {
    const slot = this.slots.get(handle);
    if (!slot) return;
    slot.item = item;
    slot.id = id;
    this.emit();
  }

  delete(handle: number): void {
    if (this.slots.delete(handle)) this.emit();
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/** Props for the React portal adapter over {@link Infini2DomHost}. */
export interface Infini2ListProps<
  TItem,
  TCursor,
  TId extends Infini2Id,
  TTarget,
> {
  /** Long-lived controller created directly or by `useInfini2`. */
  controller: Infini2Controller<TItem, TCursor, TId, TTarget>;
  /** Renders React content inside a stable DOM row shell. */
  renderItem(item: TItem, id: TId): ReactNode;
  /** Window or overflow element owning scroll. Defaults to `window`. */
  scrollHost?: Window | HTMLElement;
  /** Start-side fixed-overlay inset in CSS pixels. */
  paddingStart?: number;
  /** End-side fixed-overlay inset in CSS pixels. */
  paddingEnd?: number;
  /** Start-side Layout overscan in CSS pixels; defaults to one viewport. */
  layoutBefore?: number;
  /** End-side Layout overscan in CSS pixels; defaults to one viewport. */
  layoutAfter?: number;
  /** Compensation waterline ratio inside VisibleWindow. Defaults to `0`. */
  anchorRatio?: number;
  /** Class applied to the complete scroll-surface container. */
  className?: string;
  /** Style applied to the surface; framework-owned height/position still win. */
  style?: CSSProperties;
  /** Class applied to every stable row shell. */
  rowClassName?: string;
  /** Receives the mounted DOM executor, then `null` during cleanup. */
  onHostChange?: (
    host: Infini2DomHost<TItem, TCursor, TId, TTarget> | null,
  ) => void;
}

/**
 * React portal adapter. The DOM host owns stable row shells and may move them;
 * React owns only each shell's portal contents, preserving component state.
 *
 * @returns A relative scroll-surface container populated through portals.
 * @remarks Keep `controller` stable. Changing host geometry props recreates the
 * DOM executor but preserves the controller and registered data.
 */
export function Infini2List<
  TItem,
  TCursor,
  TId extends Infini2Id,
  TTarget = never,
>({
  controller,
  renderItem,
  scrollHost,
  paddingStart,
  paddingEnd,
  layoutBefore,
  layoutAfter,
  anchorRatio,
  className,
  style,
  rowClassName,
  onHostChange,
}: Infini2ListProps<TItem, TCursor, TId, TTarget>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const store = useMemo(() => new PortalStore<TItem, TId>(), []);
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const host = new Infini2DomHost<TItem, TCursor, TId, TTarget>({
      controller,
      container,
      scrollHost,
      paddingStart,
      paddingEnd,
      layoutBefore,
      layoutAfter,
      anchorRatio,
      createRow(item, id) {
        const handle = controller.getSnapshot().getHandle(id);
        if (handle == null) throw new Error("Infini2 portal row has no handle");
        const node = container.ownerDocument.createElement("div");
        node.dataset.infini2Handle = String(handle);
        if (rowClassName) node.className = rowClassName;
        store.set({ handle, id, item, node });
        return node;
      },
      updateRow(_node, item, id) {
        const handle = controller.getSnapshot().getHandle(id);
        if (handle != null) store.update(handle, item, id);
      },
      disposeRow(node) {
        const handle = Number(node.dataset.infini2Handle);
        if (Number.isFinite(handle)) store.delete(handle);
      },
    });
    onHostChange?.(host);
    return () => {
      onHostChange?.(null);
      host.dispose();
    };
  }, [
    anchorRatio,
    controller,
    paddingEnd,
    paddingStart,
    layoutAfter,
    layoutBefore,
    onHostChange,
    rowClassName,
    scrollHost,
    store,
  ]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", ...style }}
    >
      {store
        .values()
        .map((slot) =>
          createPortal(renderItem(slot.item, slot.id), slot.node, slot.handle),
        )}
    </div>
  );
}
