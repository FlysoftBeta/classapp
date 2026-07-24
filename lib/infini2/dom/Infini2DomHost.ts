import type {
  Infini2Alignment,
  Infini2Candidate,
  Infini2Controller,
  Infini2Id,
  Infini2LayoutItem,
  Infini2Measurement,
  Infini2Snapshot,
} from "../data";
import {
  measureInfini2Host,
  scrollInfini2Host,
  type Infini2ScrollHost,
} from "./coordinates";

/** Lifecycle hooks for framework-neutral, stable row elements. */
export interface Infini2RowHooks<TItem, TId extends Infini2Id> {
  /** Creates the final live row node. It may first be mounted in hidden staging. */
  createRow(item: TItem, id: TId): HTMLElement;
  /** Updates an existing stable node when its business object changes. */
  updateRow?(node: HTMLElement, item: TItem, id: TId): void;
  /** Releases framework resources immediately before a row node is discarded. */
  disposeRow?(node: HTMLElement, item: TItem, id: TId): void;
}

/** Construction options for the framework-neutral DOM executor. */
export interface Infini2DomHostOptions<
  TItem,
  TCursor,
  TId extends Infini2Id,
  TTarget,
> extends Infini2RowHooks<TItem, TId> {
  /** Controller whose effects, candidate, layout, and corrections are executed. */
  controller: Infini2Controller<TItem, TCursor, TId, TTarget>;
  /** The element whose height represents the complete 20V + island surface. */
  container: HTMLElement;
  /** Physical scroll owner. Defaults to the container's owning `window`. */
  scrollHost?: Window | HTMLElement;
  /** Start-side fixed-overlay inset in CSS pixels. Defaults to `0`. */
  paddingStart?: number;
  /** End-side fixed-overlay inset in CSS pixels. Defaults to `0`. */
  paddingEnd?: number;
  /** Start-side Layout overscan in pixels. Defaults to one viewport. */
  layoutBefore?: number;
  /** End-side Layout overscan in pixels. Defaults to one viewport. */
  layoutAfter?: number;
  /** Waterline used while ResizeObserver measurements change geometry. */
  anchorRatio?: number;
}

interface RowSlot<TItem, TId extends Infini2Id> {
  handle: number;
  id: TId;
  item: TItem;
  node: HTMLElement;
  measured: boolean;
}

interface PendingItemScroll<TId extends Infini2Id> {
  trace: number;
  id: TId;
  alignment: Infini2Alignment;
  waitingFor: "layout" | "measurement";
}

const POSITION_EPSILON = 0.01;
let nextItemScrollTrace = 1;
let nextFrameTrace = 1;

function debugNumber(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function resizeObserverBlockSize(entry: ResizeObserverEntry): number {
  const boxes = entry.borderBoxSize as
    readonly ResizeObserverSize[] | ResizeObserverSize | undefined;
  const box = Array.isArray(boxes) ? boxes[0] : boxes;
  return box?.blockSize ?? entry.contentRect.height;
}

/**
 * Framework-neutral DOM executor. Candidate and newly entering Layout rows are
 * measured in a hidden, width-matched staging region, then moved into one
 * flow-based live track. The track owns the single surface-relative transform.
 *
 * @remarks
 * The host owns row element placement, ResizeObservers, focus pinning, Layout
 * ACKs, and physical scroll correction. It does not own the controller lifecycle.
 */
export class Infini2DomHost<
  TItem,
  TCursor,
  TId extends Infini2Id,
  TTarget = never,
> {
  private readonly controller: Infini2Controller<TItem, TCursor, TId, TTarget>;
  private readonly container: HTMLElement;
  private readonly hooks: Infini2RowHooks<TItem, TId>;
  private readonly ownerWindow: Window;
  private readonly scrollHost: Infini2ScrollHost;
  private readonly liveTrack: HTMLDivElement;
  private readonly staging: HTMLDivElement;
  private readonly slots = new Map<number, RowSlot<TItem, TId>>();
  private readonly staged = new Map<number, RowSlot<TItem, TId>>();
  private readonly pendingLive = new Map<number, RowSlot<TItem, TId>>();
  private readonly gaps = new Map<string, HTMLDivElement>();
  private readonly nodeHandles = new WeakMap<HTMLElement, number>();
  private readonly pendingMeasurements = new Map<number, number>();
  private readonly rowObserver: ResizeObserver | null;
  private readonly hostObserver: ResizeObserver | null;
  private readonly unsubscribe: () => void;
  private readonly removeCandidatePreparer: () => void;
  private paddingStart: number;
  private paddingEnd: number;
  private layoutBefore: number | null;
  private layoutAfter: number | null;
  private anchorRatio: number;
  private frame: number | null = null;
  private fallbackMeasurementFrame: number | null = null;
  private surfaceExtent: number | null = null;
  private liveTrackStart: number | null = null;
  private pendingItemScroll: PendingItemScroll<TId> | null = null;
  private pinnedHandle: number | null = null;
  private disposed = false;

  /**
   * Attaches event listeners and schedules the first layout transaction.
   *
   * @throws If `container` is not attached to a live document/window.
   */
  constructor(options: Infini2DomHostOptions<TItem, TCursor, TId, TTarget>) {
    this.controller = options.controller;
    this.container = options.container;
    this.hooks = options;
    const ownerWindow = this.container.ownerDocument.defaultView;
    if (!ownerWindow)
      throw new Error("Infini2DomHost requires a live document");
    this.ownerWindow = ownerWindow;
    this.scrollHost = options.scrollHost ?? ownerWindow;
    this.paddingStart = options.paddingStart ?? 0;
    this.paddingEnd = options.paddingEnd ?? 0;
    this.layoutBefore = options.layoutBefore ?? null;
    this.layoutAfter = options.layoutAfter ?? null;
    this.anchorRatio = options.anchorRatio ?? 0;

    this.container.style.position = "relative";
    this.container.style.overflowAnchor = "none";
    this.liveTrack = this.container.ownerDocument.createElement("div");
    this.liveTrack.dataset.infini2LiveTrack = "";
    Object.assign(this.liveTrack.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "auto",
      overflow: "visible",
      contain: "layout style",
      transform: "translate3d(0, 0px, 0)",
    });
    this.staging = this.container.ownerDocument.createElement("div");
    this.staging.dataset.infini2Staging = "";
    Object.assign(this.staging.style, {
      position: "absolute",
      visibility: "hidden",
      pointerEvents: "none",
      top: "0",
      left: "0",
      width: "100%",
      height: "auto",
      overflow: "visible",
      contain: "layout style",
    });
    this.container.append(this.liveTrack, this.staging);

    const ResizeObserverClass = ownerWindow.ResizeObserver;
    this.rowObserver = ResizeObserverClass
      ? new ResizeObserverClass((entries) => this.observeRows(entries))
      : null;
    this.hostObserver = ResizeObserverClass
      ? new ResizeObserverClass(() => this.schedule())
      : null;
    this.unsubscribe = this.controller.subscribe(this.schedule);
    this.removeCandidatePreparer = this.controller.setCandidatePreparer(
      (candidate) => this.stageCandidate(candidate),
    );
    this.attach();
    this.syncView();
    this.schedule();
  }

  /**
   * Updates physical viewport policy and schedules reconciliation.
   *
   * @remarks Omitted values retain their previous setting. Once a Layout
   * overscan value is set it remains an explicit pixel override.
   */
  setViewportOptions(options: {
    /** Start-side fixed-overlay inset in CSS pixels. */
    paddingStart?: number;
    /** End-side fixed-overlay inset in CSS pixels. */
    paddingEnd?: number;
    /** Start-side Layout overscan in CSS pixels. */
    layoutBefore?: number;
    /** End-side Layout overscan in CSS pixels. */
    layoutAfter?: number;
    /** Compensation waterline inside VisibleWindow, from 0 to 1. */
    anchorRatio?: number;
  }): void {
    if (options.paddingStart != null) this.paddingStart = options.paddingStart;
    if (options.paddingEnd != null) this.paddingEnd = options.paddingEnd;
    if (options.layoutBefore != null) this.layoutBefore = options.layoutBefore;
    if (options.layoutAfter != null) this.layoutAfter = options.layoutAfter;
    if (options.anchorRatio != null) this.anchorRatio = options.anchorRatio;
    this.syncView();
    this.schedule();
  }

  /**
   * Synchronously flushes already observed measurements, reconciliation, ACK,
   * and correction.
   *
   * @returns The post-layout controller snapshot.
   * @remarks Newly entering rows still honor the asynchronous hidden-measure
   * barrier. Primarily useful in deterministic tests; normal UI work is
   * frame-batched.
   */
  flushNow(): Infini2Snapshot<TItem, TId> {
    this.assertLive();
    if (this.frame != null) {
      this.ownerWindow.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    return this.performLayout();
  }

  /**
   * Scrolls an item into the requested alignment, or records the physical
   * alignment to finish after the caller re-bootstraps that item.
   *
   * @returns `false` when the stable ID is outside the current Layout window;
   * callers may then fall back to `controller.jump()`.
   * @remarks The latest command is retained even when this method returns
   * `false`. A row outside Layout therefore keeps its requested physical
   * alignment across `controller.jump()`. A Layout row still waiting in hidden
   * staging is likewise deferred until its first finite measurement is committed.
   */
  scrollToItem(id: TId, alignment: Infini2Alignment = "nearest"): boolean {
    this.assertLive();
    const trace = nextItemScrollTrace++;
    const snapshot = this.controller.getSnapshot();
    const item = snapshot.layoutItems.find((row) => Object.is(row.id, id));
    const layoutLast = snapshot.layoutItems[snapshot.layoutItems.length - 1];
    this.logItemScroll(trace, "request", {
      id: String(id),
      alignment,
      phase: snapshot.phase.status,
      revision: snapshot.revision,
      layoutRevision: snapshot.layoutRevision,
      layoutCount: snapshot.layoutItems.length,
      layoutFirst: snapshot.layoutItems[0]
        ? String(snapshot.layoutItems[0].id)
        : null,
      layoutLast: layoutLast ? String(layoutLast.id) : null,
      targetInLayout: item != null,
      islandOrigin: debugNumber(snapshot.islandOrigin),
      mainExtent: debugNumber(snapshot.mainExtent),
      surfaceExtent: debugNumber(snapshot.surfaceExtent),
      visibleStart: debugNumber(snapshot.visible.start),
      visibleEnd: debugNumber(snapshot.visible.end),
      exhaustedAfter: snapshot.exhaustedAfter,
      host: this.scrollHost === this.ownerWindow ? "window" : "element",
      ...this.physicalHostState(),
    });
    if (!item) {
      this.pendingItemScroll = {
        trace,
        id,
        alignment,
        waitingFor: "layout",
      };
      this.logItemScroll(trace, "pending-layout", { id: String(id) });
      return false;
    }

    const slot = this.slots.get(item.handle);
    if (!slot?.measured) {
      this.pendingItemScroll = {
        trace,
        id,
        alignment,
        waitingFor: "measurement",
      };
      this.logItemScroll(trace, "pending-measurement", {
        id: String(id),
        handle: item.handle,
        slot: slot ? "live-unmeasured" : "not-live",
      });
      this.schedule();
      return true;
    }

    this.pendingItemScroll = null;
    const metrics = measureInfini2Host(this.scrollHost, this.container);
    this.scrollLiveSlot(slot, alignment, metrics, trace);
    this.schedule();
    return true;
  }

  private scrollLiveSlot(
    slot: RowSlot<TItem, TId>,
    alignment: Infini2Alignment,
    metrics: ReturnType<typeof measureInfini2Host>,
    trace: number,
  ): void {
    const itemRect = slot.node.getBoundingClientRect();
    let visibleTop: number;
    let visibleBottom: number;
    if (this.scrollHost === this.ownerWindow) {
      visibleTop = this.paddingStart;
      visibleBottom = this.ownerWindow.innerHeight - this.paddingEnd;
    } else {
      const host = this.scrollHost as HTMLElement;
      const hostRect = host.getBoundingClientRect();
      visibleTop = hostRect.top + host.clientTop + this.paddingStart;
      visibleBottom =
        hostRect.top + host.clientTop + host.clientHeight - this.paddingEnd;
    }

    let delta: number;
    switch (alignment) {
      case "start":
        delta = itemRect.top - visibleTop;
        break;
      case "center":
        delta =
          (itemRect.top + itemRect.bottom) * 0.5 -
          (visibleTop + visibleBottom) * 0.5;
        break;
      case "end":
        delta = itemRect.bottom - visibleBottom;
        break;
      case "nearest":
        if (itemRect.top >= visibleTop && itemRect.bottom <= visibleBottom) {
          this.logItemScroll(trace, "already-visible", {
            id: String(slot.id),
            itemTop: debugNumber(itemRect.top),
            itemBottom: debugNumber(itemRect.bottom),
            visibleTop: debugNumber(visibleTop),
            visibleBottom: debugNumber(visibleBottom),
          });
          return;
        }
        delta =
          itemRect.top < visibleTop
            ? itemRect.top - visibleTop
            : itemRect.bottom - visibleBottom;
        break;
    }

    const localScroll = metrics.localScroll + delta;
    this.logItemScroll(trace, "align-write", {
      id: String(slot.id),
      alignment,
      itemTop: debugNumber(itemRect.top),
      itemBottom: debugNumber(itemRect.bottom),
      itemHeight: debugNumber(itemRect.height),
      visibleTop: debugNumber(visibleTop),
      visibleBottom: debugNumber(visibleBottom),
      delta: debugNumber(delta),
      localBefore: debugNumber(metrics.localScroll),
      localRequested: debugNumber(localScroll),
      surfaceOffset: debugNumber(metrics.surfaceOffset),
      physicalRequested: debugNumber(metrics.surfaceOffset + localScroll),
      ...this.physicalHostState(),
    });
    scrollInfini2Host(this.scrollHost, metrics.surfaceOffset, localScroll);
    const appliedMetrics = measureInfini2Host(this.scrollHost, this.container);
    this.setControllerView(appliedMetrics, appliedMetrics.localScroll);
    const appliedRect = slot.node.getBoundingClientRect();
    this.logItemScroll(trace, "align-applied", {
      id: String(slot.id),
      localActual: debugNumber(appliedMetrics.localScroll),
      physicalError: debugNumber(appliedMetrics.localScroll - localScroll),
      itemTop: debugNumber(appliedRect.top),
      itemBottom: debugNumber(appliedRect.bottom),
      endError: debugNumber(appliedRect.bottom - visibleBottom),
      ...this.physicalHostState(),
    });
    this.ownerWindow.requestAnimationFrame(() => {
      if (this.disposed || !slot.node.isConnected) return;
      const settledMetrics = measureInfini2Host(
        this.scrollHost,
        this.container,
      );
      const settledRect = slot.node.getBoundingClientRect();
      this.logItemScroll(trace, "next-frame", {
        id: String(slot.id),
        localActual: debugNumber(settledMetrics.localScroll),
        itemTop: debugNumber(settledRect.top),
        itemBottom: debugNumber(settledRect.bottom),
        endError: debugNumber(settledRect.bottom - visibleBottom),
        ...this.physicalHostState(),
      });
    });
  }

  private logItemScroll(
    trace: number,
    event: string,
    detail: Record<string, unknown>,
  ): void {
    const debug = this.controller.debug;
    if (!debug) return;
    console.info(
      "[Infini2 scroll]",
      JSON.stringify({ debug, trace, event, ...detail }),
    );
  }

  private physicalHostState(): Record<string, number | null> {
    if (this.scrollHost === this.ownerWindow) {
      const documentElement = this.container.ownerDocument.documentElement;
      const body = this.container.ownerDocument.body;
      const scrollExtent = Math.max(
        documentElement.scrollHeight,
        body?.scrollHeight ?? 0,
      );
      return {
        physicalScroll: debugNumber(this.ownerWindow.scrollY),
        physicalMax: debugNumber(
          Math.max(0, scrollExtent - this.ownerWindow.innerHeight),
        ),
        scrollExtent: debugNumber(scrollExtent),
        viewportExtent: debugNumber(this.ownerWindow.innerHeight),
      };
    }
    const host = this.scrollHost as HTMLElement;
    return {
      physicalScroll: debugNumber(host.scrollTop),
      physicalMax: debugNumber(
        Math.max(0, host.scrollHeight - host.clientHeight),
      ),
      scrollExtent: debugNumber(host.scrollHeight),
      viewportExtent: debugNumber(host.clientHeight),
    };
  }

  /**
   * Detaches observers/listeners and disposes all row nodes owned by this host.
   *
   * @remarks Idempotent. The controller remains owned by its creator.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame != null) this.ownerWindow.cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.fallbackMeasurementFrame != null) {
      this.ownerWindow.cancelAnimationFrame(this.fallbackMeasurementFrame);
      this.fallbackMeasurementFrame = null;
    }
    this.detach();
    this.unsubscribe();
    this.removeCandidatePreparer();
    this.rowObserver?.disconnect();
    this.hostObserver?.disconnect();
    for (const slot of this.slots.values()) this.disposeSlot(slot);
    for (const slot of this.staged.values()) this.disposeSlot(slot);
    for (const slot of this.pendingLive.values()) this.disposeSlot(slot);
    this.slots.clear();
    this.staged.clear();
    this.pendingLive.clear();
    this.gaps.clear();
    this.liveTrack.remove();
    this.staging.remove();
  }

  private schedule = (): void => {
    if (this.disposed || this.frame != null) return;
    this.frame = this.ownerWindow.requestAnimationFrame(() => {
      this.frame = null;
      this.performLayout();
    });
  };

  private performLayout(): Infini2Snapshot<TItem, TId> {
    const trace = nextFrameTrace++;
    this.syncFocusPin();
    const metrics = this.syncView();
    this.flushObservedMeasurements();
    const snapshot = this.controller.getSnapshot();
    this.logFrame(trace, "begin", snapshot, metrics);
    this.setSurfaceExtent(snapshot.surfaceExtent);
    this.reconcile(snapshot.layoutItems);
    if (snapshot.candidate == null) this.pruneStaged();
    this.controller.commitLayout(
      snapshot.layoutRevision,
      snapshot.layoutItems
        .map((item) => item.handle)
        .filter((handle) => this.slots.get(handle)?.measured === true),
    );
    this.applyScrollCorrection(trace);
    this.applyPendingItemScroll();
    const settled = this.controller.getSnapshot();
    this.logFrame(
      trace,
      "end",
      settled,
      measureInfini2Host(this.scrollHost, this.container),
    );
    return settled;
  }

  private reconcile(
    layoutItems: readonly Infini2LayoutItem<TItem, TId>[],
  ): void {
    const wanted = new Map(layoutItems.map((item) => [item.handle, item]));
    const activeElement = this.container.ownerDocument.activeElement;
    for (const [handle, slot] of this.slots) {
      if (wanted.has(handle)) continue;
      if (activeElement && slot.node.contains(activeElement)) {
        this.controller.pin(slot.id, true);
        continue;
      }
      this.disposeSlot(slot);
      this.slots.delete(handle);
    }

    for (const [handle, slot] of this.pendingLive) {
      if (wanted.has(handle)) continue;
      this.disposeSlot(slot);
      this.pendingLive.delete(handle);
    }

    for (const layout of layoutItems) {
      let slot = this.slots.get(layout.handle);
      if (!slot) {
        slot = this.staged.get(layout.handle);
        if (!slot) slot = this.pendingLive.get(layout.handle);
        if (!slot) {
          slot = this.createSlot(layout.handle, layout.id, layout.item);
          this.pendingLive.set(layout.handle, slot);
          this.positionStagedNode(slot);
          this.staging.appendChild(slot.node);
          this.observeSlot(slot);
        }
        if (!slot.measured) {
          if (!Object.is(slot.item, layout.item)) {
            slot.item = layout.item;
            slot.id = layout.id;
            this.hooks.updateRow?.(slot.node, layout.item, layout.id);
          }
          continue;
        }
        this.staged.delete(layout.handle);
        this.pendingLive.delete(layout.handle);
        this.slots.set(layout.handle, slot);
        this.positionLiveNode(slot);
        this.observeSlot(slot);
      } else if (!Object.is(slot.item, layout.item)) {
        slot.item = layout.item;
        slot.id = layout.id;
        this.hooks.updateRow?.(slot.node, layout.item, layout.id);
      }
      this.setSlotVisibility(slot, true);
    }

    this.syncLiveTrack(layoutItems);
    if (!this.rowObserver && this.pendingLive.size) {
      this.scheduleFallbackMeasurements();
    }
  }

  private async stageCandidate(
    candidate: Infini2Candidate<TItem, TId>,
  ): Promise<readonly Infini2Measurement[]> {
    if (this.disposed) return [];
    const wanted = new Set(candidate.items.map((item) => item.handle));
    for (const [handle, slot] of this.staged) {
      if (!wanted.has(handle)) {
        this.disposeSlot(slot);
        this.staged.delete(handle);
      }
    }
    const fragment = this.container.ownerDocument.createDocumentFragment();
    for (const item of candidate.items) {
      let slot = this.staged.get(item.handle);
      if (!slot) {
        slot = this.createSlot(item.handle, item.id, item.item);
        this.staged.set(item.handle, slot);
      } else if (!Object.is(slot.item, item.item)) {
        slot.item = item.item;
        slot.id = item.id;
        this.hooks.updateRow?.(slot.node, item.item, item.id);
      }
      this.positionStagedNode(slot);
      fragment.appendChild(slot.node);
    }
    this.staging.appendChild(fragment);
    // Portal-based adapters need one React commit after the slot shells enter
    // the document. Bare DOM rows simply spend one hidden frame here.
    await new Promise<void>((resolve) => {
      this.ownerWindow.requestAnimationFrame(() => resolve());
    });
    if (
      this.disposed ||
      this.controller.getSnapshot().candidate?.effectId !== candidate.effectId
    ) {
      return [];
    }
    // getBoundingClientRect is the first-measure barrier. ResizeObserver owns
    // later changes but is intentionally not required for candidate commit.
    return candidate.items.flatMap((item) => {
      const node = this.staged.get(item.handle)?.node;
      if (!node) return [];
      const extent = node.getBoundingClientRect().height;
      const slot = this.staged.get(item.handle);
      if (slot && Number.isFinite(extent) && extent > 0) slot.measured = true;
      return [{ handle: item.handle, extent }];
    });
  }

  private createSlot(
    handle: number,
    id: TId,
    item: TItem,
  ): RowSlot<TItem, TId> {
    const node = this.hooks.createRow(item, id);
    if (
      node === this.container ||
      node === this.liveTrack ||
      node === this.staging
    ) {
      throw new Error("Infini2 row cannot be its surface or staging element");
    }
    Object.assign(node.style, {
      position: "relative",
      top: "auto",
      left: "auto",
      width: "100%",
      margin: "0",
      transform: "none",
    });
    if (!node.style.display) node.style.display = "flow-root";
    this.nodeHandles.set(node, handle);
    return { handle, id, item, node, measured: false };
  }

  private setSurfaceExtent(extent: number): void {
    if (this.surfaceExtent === extent) return;
    this.surfaceExtent = extent;
    this.container.style.height = `${extent}px`;
  }

  private syncLiveTrack(
    layoutItems: readonly Infini2LayoutItem<TItem, TId>[],
  ): void {
    const liveItems = layoutItems.filter((item) => this.slots.has(item.handle));
    const trackStart = liveItems[0]?.start ?? 0;
    if (this.liveTrackStart !== trackStart) {
      this.liveTrackStart = trackStart;
      this.liveTrack.style.transform = `translate3d(0, ${trackStart}px, 0)`;
    }

    const wantedGaps = new Set<string>();
    const desired: HTMLElement[] = [];
    let previous: Infini2LayoutItem<TItem, TId> | null = null;
    for (const item of liveItems) {
      if (previous) {
        const gapExtent = item.start - (previous.start + previous.extent);
        if (gapExtent > POSITION_EPSILON) {
          const key = `${previous.handle}:${item.handle}`;
          wantedGaps.add(key);
          let gap = this.gaps.get(key);
          if (!gap) {
            gap = this.container.ownerDocument.createElement("div");
            gap.dataset.infini2Gap = key;
            gap.setAttribute("aria-hidden", "true");
            Object.assign(gap.style, {
              width: "100%",
              margin: "0",
              padding: "0",
              border: "0",
              pointerEvents: "none",
            });
            this.gaps.set(key, gap);
          }
          const height = `${gapExtent}px`;
          if (gap.style.height !== height) gap.style.height = height;
          desired.push(gap);
        }
      }
      const node = this.slots.get(item.handle)?.node;
      if (node) desired.push(node);
      previous = item;
    }

    for (const [key, gap] of this.gaps) {
      if (wantedGaps.has(key)) continue;
      gap.remove();
      this.gaps.delete(key);
    }

    const restoreFocus = this.captureFocus();
    let cursor = this.liveTrack.firstChild;
    for (const node of desired) {
      if (node === cursor) {
        cursor = cursor.nextSibling;
        continue;
      }
      this.liveTrack.insertBefore(node, cursor);
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    restoreFocus?.();
  }

  private setSlotVisibility(slot: RowSlot<TItem, TId>, visible: boolean): void {
    const visibility = visible ? "visible" : "hidden";
    if (slot.node.style.visibility !== visibility) {
      slot.node.style.visibility = visibility;
    }
  }

  private observeSlot(slot: RowSlot<TItem, TId>): void {
    if (!this.rowObserver) return;
    try {
      this.rowObserver.observe(slot.node, { box: "border-box" });
    } catch {
      this.rowObserver.observe(slot.node);
    }
  }

  private scheduleFallbackMeasurements(): void {
    if (this.fallbackMeasurementFrame != null || this.disposed) return;
    this.fallbackMeasurementFrame = this.ownerWindow.requestAnimationFrame(
      () => {
        this.fallbackMeasurementFrame = null;
        for (const [handle, slot] of this.pendingLive) {
          const extent = slot.node.getBoundingClientRect().height;
          if (!Number.isFinite(extent) || extent <= 0) continue;
          slot.measured = true;
          this.pendingMeasurements.set(handle, extent);
        }
        if (this.pendingMeasurements.size) this.schedule();
      },
    );
  }

  private positionLiveNode(slot: RowSlot<TItem, TId>): void {
    this.setSlotVisibility(slot, slot.measured);
  }

  private positionStagedNode(slot: RowSlot<TItem, TId>): void {
    this.setSlotVisibility(slot, false);
  }

  private observeRows(entries: readonly ResizeObserverEntry[]): void {
    for (const entry of entries) {
      const node = entry.target as HTMLElement;
      const handle = this.nodeHandles.get(node);
      if (handle == null) continue;
      const slot = this.slots.get(handle) ?? this.pendingLive.get(handle);
      if (!slot) continue;
      const extent = resizeObserverBlockSize(entry);
      if (!Number.isFinite(extent) || extent <= 0) continue;
      slot.measured = true;
      this.pendingMeasurements.set(handle, extent);
    }
    this.schedule();
  }

  private flushObservedMeasurements(): void {
    if (!this.pendingMeasurements.size) return;
    this.controller.captureAnchor(this.anchorRatio);
    this.controller.measure(
      [...this.pendingMeasurements]
        .filter(
          ([handle]) => this.slots.has(handle) || this.pendingLive.has(handle),
        )
        .map(([handle, extent]) => ({ handle, extent })),
    );
    this.pendingMeasurements.clear();
  }

  private applyScrollCorrection(trace: number): void {
    const correction = this.controller.takeScrollCorrection();
    if (correction == null) return;
    // Surface and live-track writes can synchronously clamp the physical
    // scroll position, making the transaction's initial metrics stale.
    const metrics = measureInfini2Host(this.scrollHost, this.container);
    const pending = this.pendingItemScroll;
    this.logFrameEvent(trace, "correction-request", {
      pendingItemId: pending ? String(pending.id) : null,
      localBefore: debugNumber(metrics.localScroll),
      localRequested: debugNumber(correction),
      surfaceOffset: debugNumber(metrics.surfaceOffset),
      physicalRequested: debugNumber(metrics.surfaceOffset + correction),
      ...this.physicalHostState(),
    });
    if (Math.abs(metrics.localScroll - correction) >= POSITION_EPSILON) {
      scrollInfini2Host(this.scrollHost, metrics.surfaceOffset, correction);
    }
    // A browser may clamp even this write to its current scroll range. The
    // core must ACK the observed landing, not a position the host never reached.
    const appliedMetrics = measureInfini2Host(this.scrollHost, this.container);
    this.logFrameEvent(trace, "correction-applied", {
      localRequested: debugNumber(correction),
      localActual: debugNumber(appliedMetrics.localScroll),
      physicalError: debugNumber(appliedMetrics.localScroll - correction),
      surfaceOffset: debugNumber(appliedMetrics.surfaceOffset),
      ...this.physicalHostState(),
    });
    this.setControllerView(appliedMetrics, appliedMetrics.localScroll);
  }

  private logFrame(
    trace: number,
    event: string,
    snapshot: Infini2Snapshot<TItem, TId>,
    metrics: ReturnType<typeof measureInfini2Host>,
  ): void {
    if (!this.controller.debug) return;
    this.logFrameEvent(trace, event, {
      phase: snapshot.phase.status,
      revision: snapshot.revision,
      layoutRevision: snapshot.layoutRevision,
      blankZone: snapshot.blankZone,
      mainIsland: snapshot.mainIsland,
      mainLength: snapshot.mainLength,
      mainExtent: debugNumber(snapshot.mainExtent),
      islandOrigin: debugNumber(snapshot.islandOrigin),
      surfaceExtent: debugNumber(snapshot.surfaceExtent),
      visibleStart: debugNumber(snapshot.visible.start),
      visibleEnd: debugNumber(snapshot.visible.end),
      layoutStart: debugNumber(snapshot.layoutTarget.start),
      layoutEnd: debugNumber(snapshot.layoutTarget.end),
      layoutCount: snapshot.layoutItems.length,
      layoutFirst: snapshot.layoutItems[0]
        ? String(snapshot.layoutItems[0].id)
        : null,
      layoutLast: snapshot.layoutItems[snapshot.layoutItems.length - 1]
        ? String(snapshot.layoutItems[snapshot.layoutItems.length - 1]!.id)
        : null,
      candidateEffect: snapshot.candidate?.effectId ?? null,
      effectIds: snapshot.effects.map((effect) => effect.id),
      localScroll: debugNumber(metrics.localScroll),
      surfaceOffset: debugNumber(metrics.surfaceOffset),
      liveCount: this.slots.size,
      stagedCount: this.staged.size,
      pendingLiveCount: this.pendingLive.size,
      ...this.physicalHostState(),
    });
  }

  private logFrameEvent(
    trace: number,
    event: string,
    detail: Record<string, unknown>,
  ): void {
    const debug = this.controller.debug;
    if (!debug) return;
    console.info(
      "[Infini2 frame]",
      JSON.stringify({ debug, trace, event, ...detail }),
    );
  }

  private applyPendingItemScroll(): void {
    const pending = this.pendingItemScroll;
    if (!pending) return;
    const snapshot = this.controller.getSnapshot();
    const item = snapshot.layoutItems.find((row) =>
      Object.is(row.id, pending.id),
    );
    if (!item) {
      if (pending.waitingFor !== "layout") {
        pending.waitingFor = "layout";
        this.logItemScroll(pending.trace, "pending-layout", {
          id: String(pending.id),
          phase: snapshot.phase.status,
          layoutRevision: snapshot.layoutRevision,
        });
      }
      return;
    }
    if (this.slots.get(item.handle)?.measured !== true) {
      if (pending.waitingFor !== "measurement") {
        pending.waitingFor = "measurement";
        this.logItemScroll(pending.trace, "pending-measurement", {
          id: String(pending.id),
          handle: item.handle,
          phase: snapshot.phase.status,
          layoutRevision: snapshot.layoutRevision,
        });
      }
      return;
    }
    const slot = this.slots.get(item.handle)!;
    this.pendingItemScroll = null;
    const metrics = measureInfini2Host(this.scrollHost, this.container);
    this.logItemScroll(pending.trace, "pending-ready", {
      id: String(pending.id),
      handle: item.handle,
      phase: snapshot.phase.status,
      layoutRevision: snapshot.layoutRevision,
    });
    this.scrollLiveSlot(slot, pending.alignment, metrics, pending.trace);
  }

  private syncView = (): ReturnType<typeof measureInfini2Host> => {
    const metrics = measureInfini2Host(this.scrollHost, this.container);
    this.setControllerView(metrics, metrics.localScroll);
    return metrics;
  };

  private setControllerView(
    metrics: ReturnType<typeof measureInfini2Host>,
    scroll: number,
  ): void {
    this.controller.setView({
      scroll,
      viewport: metrics.viewport,
      paddingStart: this.paddingStart,
      paddingEnd: this.paddingEnd,
      layoutBefore: this.layoutBefore ?? metrics.viewport,
      layoutAfter: this.layoutAfter ?? metrics.viewport,
    });
  }

  private attach(): void {
    this.scrollHost.addEventListener("scroll", this.handleScroll, {
      passive: true,
    });
    this.ownerWindow.addEventListener("resize", this.schedule, {
      passive: true,
    });
    this.container.addEventListener("focusin", this.schedule);
    this.container.addEventListener("focusout", this.schedule);
    this.hostObserver?.observe(
      this.scrollHost === this.ownerWindow
        ? this.container
        : (this.scrollHost as HTMLElement),
    );
  }

  private detach(): void {
    this.scrollHost.removeEventListener("scroll", this.handleScroll);
    this.ownerWindow.removeEventListener("resize", this.schedule);
    this.container.removeEventListener("focusin", this.schedule);
    this.container.removeEventListener("focusout", this.schedule);
    if (this.pinnedHandle != null) {
      const slot = this.slots.get(this.pinnedHandle);
      if (slot) this.controller.pin(slot.id, false);
      this.pinnedHandle = null;
    }
  }

  private handleScroll = (): void => {
    const metrics = measureInfini2Host(this.scrollHost, this.container);
    const snapshot = this.controller.getSnapshot();
    this.logFrameEvent(0, "native-scroll", {
      phase: snapshot.phase.status,
      blankZone: snapshot.blankZone,
      mainIsland: snapshot.mainIsland,
      layoutCount: snapshot.layoutItems.length,
      localScroll: debugNumber(metrics.localScroll),
      surfaceOffset: debugNumber(metrics.surfaceOffset),
      ...this.physicalHostState(),
    });
    this.schedule();
  };

  private syncFocusPin(): void {
    const active = this.container.ownerDocument.activeElement;
    const focused = [...this.slots.values()].find(
      (slot) => active != null && slot.node.contains(active),
    );
    const next = focused?.handle ?? null;
    if (next === this.pinnedHandle) return;
    if (this.pinnedHandle != null) {
      const previous = this.slots.get(this.pinnedHandle);
      if (previous) this.controller.pin(previous.id, false);
    }
    this.pinnedHandle = next;
    if (focused) this.controller.pin(focused.id, true);
  }

  private disposeSlot(slot: RowSlot<TItem, TId>): void {
    this.rowObserver?.unobserve(slot.node);
    this.hooks.disposeRow?.(slot.node, slot.item, slot.id);
    slot.node.remove();
  }

  private pruneStaged(): void {
    for (const [handle, slot] of this.staged) {
      this.disposeSlot(slot);
      this.staged.delete(handle);
    }
  }

  private captureFocus(): (() => void) | null {
    const active = this.container.ownerDocument
      .activeElement as HTMLElement | null;
    if (!active || !this.container.contains(active)) return null;
    return () => {
      if (
        active.isConnected &&
        this.container.ownerDocument.activeElement !== active
      ) {
        active.focus({ preventScroll: true });
      }
    };
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("Infini2DomHost has been disposed");
  }
}
