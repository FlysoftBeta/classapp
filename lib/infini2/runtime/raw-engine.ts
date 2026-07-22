import { getInfini2WasmExports } from "./wasm-module";

/** Numeric content-order direction used by the Wasm ABI. @advanced */
export const enum RawDirection {
  /** Toward lower content ranks. */
  Before = 0,
  /** Toward higher content ranks. */
  After = 1,
}

/** Numeric state of one known island edge. @advanced */
export const enum RawEdge {
  /** More content may exist. */
  Open = 0,
  /** The Provider proved that no content exists beyond this edge. */
  Exhausted = 1,
}

/** Selects a core extent-based window. @advanced */
export const enum RawWindow {
  /** Unobscured visible viewport. */
  Visible = 0,
  /** Desired visible window plus pixel overscan. */
  LayoutTarget = 1,
  /** Last physical layout acknowledged by the executor. */
  LayoutCommitted = 2,
}

/** Predictive Blank Zone containing the current waterline. @advanced */
export const enum RawBlankZone {
  /** The waterline remains in continuous-scroll territory. */
  None = 0,
  /** The waterline requires a discontinuous before seek. */
  Before = 1,
  /** The waterline requires a discontinuous after seek. */
  After = 2,
}

/** Kind of asynchronous work requested by the core. @advanced */
export const enum RawEffectKind {
  /** Create the first main island. */
  Bootstrap = 0,
  /** Extend a known adjacent frontier. */
  EdgeFetch = 1,
  /** Establish a new island at a discontinuous location. */
  Seek = 2,
}

/** Lifecycle state of a raw effect ticket. @advanced */
export const enum RawEffectState {
  /** Awaiting Provider resolution. */
  Pending = 0,
  /** No longer allowed to replace the foreground, but still reusable as Stale. */
  Detached = 1,
  /** Provider data is accepted and awaits candidate measurement/commit. */
  AwaitingCommit = 2,
}

/** Result of returning effect data to the core. @advanced */
export const enum RawCommitDisposition {
  /** The effect or returned topology is invalid. */
  Rejected = 0,
  /** Data extended an existing island immediately. */
  Applied = 1,
  /** Data must be hidden-measured before activation. */
  Candidate = 2,
  /** A detached activation result was preserved as Stale. */
  StoredStale = 3,
  /** A valid but no-longer-useful result was discarded. */
  Dropped = 4,
}

/** Target placement inside VisibleWindow. @advanced */
export const enum RawAlignment {
  /** Align target start to visible start. */
  Start = 0,
  /** Align target center to visible center. */
  Center = 1,
  /** Align target end to visible end. */
  End = 2,
  /** Preserve visibility when possible; otherwise use the nearest edge. */
  Nearest = 3,
}

/** Numeric item accepted by the platform-independent core. @advanced */
export interface RawItem {
  /** Non-zero stable handle allocated by the outer registry. */
  handle: number;
  /** Finite positive estimated or measured block extent in CSS pixels. */
  extent: number;
  /** Whether the supplied extent is already physically measured. */
  measured?: boolean;
}

/** Read-only row geometry produced by a core range query. @advanced */
export interface RawRow {
  /** Non-zero stable handle. */
  handle: number;
  /** Zero-based rank inside the queried island. */
  index: number;
  /** Island-local start in CSS pixels. */
  start: number;
  /** Estimated or measured block extent in CSS pixels. */
  extent: number;
  /** Whether the extent is physically measured. */
  measured: boolean;
}

/** Asynchronous work ticket emitted by the core. @advanced */
export interface RawEffect {
  /** Non-zero effect identity. */
  id: number;
  /** Requested operation. */
  kind: RawEffectKind;
  /** Current effect lifecycle. */
  state: RawEffectState;
  /** Island identity against which this work began, or `0` for initial bootstrap. */
  owner: number;
  /** Content-order direction associated with the work. */
  direction: RawDirection;
  /** Boundary/prediction anchor handle, or `0` when not applicable. */
  anchor: number;
  /** Predicted relative item count for discontinuous work. */
  signedOffset: number;
  /** Desired returned extent in CSS pixels. */
  targetExtent: number;
  /** Opaque numeric token owned by the outer target registry. */
  targetToken: number;
}

/** Physical view metrics consumed by the numeric core. @advanced */
export interface RawViewMetrics {
  /** Scroll relative to the Infini2 surface start, in CSS pixels. */
  scroll: number;
  /** Physical host viewport extent in CSS pixels. */
  viewport: number;
  /** Start-side fixed overlay inset in CSS pixels. */
  insetStart: number;
  /** End-side fixed overlay inset in CSS pixels. */
  insetEnd: number;
  /** Start-side Layout overscan in CSS pixels. */
  layoutBefore: number;
  /** End-side Layout overscan in CSS pixels. */
  layoutAfter: number;
}

/** Numeric point-in-time topology, window, and Residency observation. @advanced */
export interface RawSnapshot {
  /** Main island identity, or `0`. */
  main: number;
  /** Before-side stale island identity, or `0`. */
  staleBefore: number;
  /** After-side stale island identity, or `0`. */
  staleAfter: number;
  /** Complete scroll-surface extent in CSS pixels. */
  surfaceExtent: number;
  /** Main-island origin inside the physical surface. */
  islandOrigin: number;
  /** Before-side Blank extent in CSS pixels. */
  blankBefore: number;
  /** After-side Blank extent in CSS pixels. */
  blankAfter: number;
  /** Predictive Blank Zone containing the waterline. */
  blankZone: RawBlankZone;
  /** Unobscured viewport in main-island-local coordinates. */
  visible: Readonly<{ start: number; end: number; size: number }>;
  /** Requested Layout window in main-island-local coordinates. */
  layoutTarget: Readonly<{ start: number; end: number; size: number }>;
  /** Number of known main items. */
  mainLength: number;
  /** Aggregate main item extent in CSS pixels. */
  mainExtent: number;
  /** Inclusive Resident start rank. */
  residentStart: number;
  /** Exclusive Resident end rank. */
  residentEnd: number;
  /** Dynamic Resident item count. */
  residentCount: number;
  /** First Resident handle, or `0`. */
  residentFirst: number;
  /** Last Resident handle, or `0`. */
  residentLast: number;
  /** Known before-side items outside Resident. */
  bufferBefore: number;
  /** Known after-side items outside Resident. */
  bufferAfter: number;
  /** Current desired physical Layout revision. */
  layoutRevision: number;
}

/** Cumulative saturating sequence-work counters. @advanced */
export interface RawDiagnostics {
  /** Sequence nodes inspected. */
  visited: number;
  /** Sequence nodes structurally or geometrically changed. */
  touched: number;
  /** Rows emitted by range queries. */
  emitted: number;
}

interface Infini2Exports extends WebAssembly.Exports {
  infini2_abi_version(): number;
  infini2_create(defaultExtent: number): number;
  infini2_destroy(pointer: number): void;
  infini2_reset(pointer: number): void;
  infini2_set_view(
    pointer: number,
    scroll: number,
    viewport: number,
    insetStart: number,
    insetEnd: number,
    layoutBefore: number,
    layoutAfter: number,
  ): void;
  infini2_set_resident_padding(
    pointer: number,
    before: number,
    after: number,
  ): void;
  infini2_set_stale_miss_limit(pointer: number, value: number): void;
  infini2_surface_extent(pointer: number): number;
  infini2_island_origin(pointer: number): number;
  infini2_blank_extent(pointer: number, direction: number): number;
  infini2_blank_zone(pointer: number): number;
  infini2_window_start(pointer: number, kind: number): number;
  infini2_window_end(pointer: number, kind: number): number;
  infini2_main_island(pointer: number): number;
  infini2_stale_island(pointer: number, direction: number): number;
  infini2_island_role(pointer: number, island: number): number;
  infini2_island_edge(
    pointer: number,
    island: number,
    direction: number,
  ): number;
  infini2_main_len(pointer: number): number;
  infini2_main_extent(pointer: number): number;
  infini2_resident_start(pointer: number): number;
  infini2_resident_end(pointer: number): number;
  infini2_resident_count(pointer: number): number;
  infini2_resident_handle(pointer: number, direction: number): number;
  infini2_buffer_count(pointer: number, direction: number): number;
  infini2_items_begin(pointer: number): void;
  infini2_items_push(
    pointer: number,
    handle: number,
    extent: number,
    measured: number,
  ): number;
  infini2_handles_begin(pointer: number): void;
  infini2_handles_push(pointer: number, handle: number): number;
  infini2_measure_begin(pointer: number): void;
  infini2_measure_push(pointer: number, handle: number, extent: number): number;
  infini2_measure_commit(pointer: number): number;
  infini2_begin_bootstrap(pointer: number, targetToken: number): number;
  infini2_begin_seek(
    pointer: number,
    direction: number,
    targetToken: number,
  ): number;
  infini2_effect_pop(pointer: number): number;
  infini2_effect_query(pointer: number, effect: number): number;
  infini2_effect_affects_main(pointer: number, effect: number): number;
  infini2_effect_id(pointer: number): number;
  infini2_effect_kind(pointer: number): number;
  infini2_effect_state(pointer: number): number;
  infini2_effect_owner(pointer: number): number;
  infini2_effect_direction(pointer: number): number;
  infini2_effect_anchor(pointer: number): number;
  infini2_effect_signed_offset(pointer: number): number;
  infini2_effect_target_extent(pointer: number): number;
  infini2_effect_target_token(pointer: number): number;
  infini2_effect_detach(pointer: number, effect: number): number;
  infini2_effect_reject(pointer: number, effect: number): number;
  infini2_effect_commit_items(
    pointer: number,
    effect: number,
    exhaustedBefore: number,
    exhaustedAfter: number,
    targetHandle: number,
    alignment: number,
  ): number;
  infini2_candidate_commit(pointer: number, effect: number): number;
  infini2_candidate_island(pointer: number, effect: number): number;
  infini2_external_insert(
    pointer: number,
    anchor: number,
    side: number,
  ): number;
  infini2_external_delete(pointer: number): number;
  infini2_edge_reopen(pointer: number, direction: number): void;
  infini2_seek_retry(pointer: number, direction: number): void;
  infini2_buffer_trim(
    pointer: number,
    direction: number,
    maxItems: number,
  ): number;
  infini2_anchor_capture(pointer: number, ratio: number): number;
  infini2_scroll_correction(pointer: number): number;
  infini2_pin(pointer: number, handle: number, pinned: number): number;
  infini2_layout_query(pointer: number): number;
  infini2_candidate_query(pointer: number, effect: number): number;
  infini2_island_query(pointer: number, island: number): number;
  infini2_row_handle(pointer: number, row: number): number;
  infini2_row_index(pointer: number, row: number): number;
  infini2_row_start(pointer: number, row: number): number;
  infini2_row_extent(pointer: number, row: number): number;
  infini2_row_measured(pointer: number, row: number): number;
  infini2_layout_revision(pointer: number): number;
  infini2_layout_commit(pointer: number, revision: number): number;
  infini2_committed_count(pointer: number): number;
  infini2_committed_handle(pointer: number, index: number): number;
  infini2_released_pop(pointer: number): number;
  infini2_diagnostics(pointer: number, field: number): number;
}

function direction(value: "before" | "after"): RawDirection {
  return value === "before" ? RawDirection.Before : RawDirection.After;
}

/**
 * Advanced numeric wrapper over the raw, import-free Infini2 Wasm ABI.
 *
 * @remarks
 * This class intentionally does not own business items, cursors, Provider
 * validation, async execution, or DOM commits. Prefer `Infini2Controller` for
 * application code. Allocation is lazy and every instance must be disposed.
 *
 * @advanced
 */
export class RawInfini2Engine {
  private pointer = 0;
  private disposed = false;

  /** Finite positive fallback extent requested by the caller. */
  readonly defaultExtent: number;

  /** Creates a lazily allocated engine using this fallback item extent. */
  constructor(defaultExtent: number) {
    this.defaultExtent = defaultExtent;
  }

  private get exports(): Infini2Exports {
    const exports = getInfini2WasmExports<Infini2Exports>();
    if (exports.infini2_abi_version() !== 6) {
      throw new Error("Infini2 Wasm ABI version mismatch");
    }
    return exports;
  }

  private get ptr(): number {
    if (this.disposed) throw new Error("Infini2 engine has been disposed");
    if (this.pointer === 0) {
      this.pointer = this.exports.infini2_create(this.defaultExtent);
      if (this.pointer === 0) throw new Error("Infini2 Wasm allocation failed");
    }
    return this.pointer;
  }

  /** Clears all islands/effects/layout while queuing unreferenced handles for release. */
  reset(): void {
    this.exports.infini2_reset(this.ptr);
  }

  /** Configures item-count Resident padding and no-anchor Stale eviction limit. */
  configure(input: {
    /** Items retained before the Layout-intersecting base range. */
    residentBefore: number;
    /** Items retained after the Layout-intersecting base range. */
    residentAfter: number;
    /** Relevant successful loads allowed without an anchor; minimum is one. */
    staleMissLimit?: number;
  }): void {
    this.exports.infini2_set_resident_padding(
      this.ptr,
      Math.max(0, Math.floor(input.residentBefore)),
      Math.max(0, Math.floor(input.residentAfter)),
    );
    if (input.staleMissLimit != null) {
      this.exports.infini2_set_stale_miss_limit(
        this.ptr,
        Math.max(1, Math.floor(input.staleMissLimit)),
      );
    }
  }

  /** Submits normalized host-local geometry and advances scheduling. */
  setView(view: RawViewMetrics): void {
    this.exports.infini2_set_view(
      this.ptr,
      view.scroll,
      view.viewport,
      view.insetStart,
      view.insetEnd,
      view.layoutBefore,
      view.layoutAfter,
    );
  }

  /** Starts initial activation and returns its non-zero effect ticket. */
  beginBootstrap(targetToken = 0): number {
    return this.exports.infini2_begin_bootstrap(this.ptr, targetToken);
  }

  /** Starts explicit discontinuous activation and returns its effect ticket. */
  beginSeek(directionValue: "before" | "after", targetToken = 0): number {
    return this.exports.infini2_begin_seek(
      this.ptr,
      direction(directionValue),
      targetToken,
    );
  }

  /** Drains newly scheduled effect tickets from the core outbox. */
  takeEffects(): RawEffect[] {
    const output: RawEffect[] = [];
    while (this.exports.infini2_effect_pop(this.ptr)) {
      output.push(this.readCurrentEffect());
    }
    return output;
  }

  /** Returns a still-live effect snapshot, or `null` after it finishes. */
  effect(effect: number): RawEffect | null {
    return this.exports.infini2_effect_query(this.ptr, effect)
      ? this.readCurrentEffect()
      : null;
  }

  /** Whether failure/success of this effect still targets the resolved main island. */
  effectAffectsMain(effect: number): boolean {
    return Boolean(this.exports.infini2_effect_affects_main(this.ptr, effect));
  }

  /** Detaches an activation effect without globally invalidating its late result. */
  detachEffect(effect: number): boolean {
    return Boolean(this.exports.infini2_effect_detach(this.ptr, effect));
  }

  /** Rejects a live effect and latches its relevant failed edge when applicable. */
  rejectEffect(effect: number): boolean {
    return Boolean(this.exports.infini2_effect_reject(this.ptr, effect));
  }

  /**
   * Returns one validated, ordered Provider slice to its owning effect.
   *
   * @returns How the core used the data. `Candidate` requires hidden measurement
   * followed by {@link commitCandidate}.
   */
  commitEffect(input: {
    /** Owning live effect ticket. */
    effect: number;
    /** Ordered, unique numeric items. */
    items: readonly RawItem[];
    /** Whether content ends before this returned page. */
    exhaustedBefore: boolean;
    /** Whether content ends after this returned page. */
    exhaustedAfter: boolean;
    /** Exact target handle inside a candidate, or `0`/omitted. */
    targetHandle?: number;
    /** Target alignment; defaults to start. */
    alignment?: RawAlignment;
  }): RawCommitDisposition {
    this.pushItems(input.items);
    return this.exports.infini2_effect_commit_items(
      this.ptr,
      input.effect,
      Number(input.exhaustedBefore),
      Number(input.exhaustedAfter),
      input.targetHandle ?? 0,
      input.alignment ?? RawAlignment.Start,
    );
  }

  /** Atomically activates a measured candidate still owned by `effect`. */
  commitCandidate(effect: number): boolean {
    return Boolean(this.exports.infini2_candidate_commit(this.ptr, effect));
  }

  /** Returns the candidate island ID for an awaiting effect, or `0`. */
  candidateIsland(effect: number): number {
    return this.exports.infini2_candidate_island(this.ptr, effect);
  }

  /** Applies an ordered external insertion to every relevant known segment. */
  externalInsert(
    anchor: number,
    side: "before" | "after",
    items: readonly RawItem[],
  ): number {
    this.pushItems(items);
    return this.exports.infini2_external_insert(
      this.ptr,
      anchor,
      direction(side),
    );
  }

  /** Applies external deletions and returns removed occurrences. */
  externalDelete(handles: readonly number[]): number {
    this.pushHandles(handles);
    return this.exports.infini2_external_delete(this.ptr);
  }

  /** Batch-updates extents and returns the number of changed occurrences. */
  measure(measurements: readonly { handle: number; extent: number }[]): number {
    this.exports.infini2_measure_begin(this.ptr);
    for (const measurement of measurements) {
      this.exports.infini2_measure_push(
        this.ptr,
        measurement.handle,
        measurement.extent,
      );
    }
    return this.exports.infini2_measure_commit(this.ptr);
  }

  /** Captures a compensation waterline and returns its handle, or `0`. */
  captureAnchor(ratio: number): number {
    return this.exports.infini2_anchor_capture(this.ptr, ratio);
  }

  /** Consumes an absolute surface-local scroll target, or returns `null`. */
  takeScrollCorrection(): number | null {
    const value = this.exports.infini2_scroll_correction(this.ptr);
    return Number.isFinite(value) ? value : null;
  }

  /** Pins/unpins a main-island row and reports whether the set changed. */
  pin(handle: number, pinned: boolean): boolean {
    return Boolean(this.exports.infini2_pin(this.ptr, handle, Number(pinned)));
  }

  /** Reopens a previously exhausted/failed frontier and resumes scheduling. */
  reopen(directionValue: "before" | "after"): void {
    this.exports.infini2_edge_reopen(this.ptr, direction(directionValue));
  }

  /** Retries a latched predictive Blank Zone seek. */
  retryPredictiveSeek(directionValue: "before" | "after"): void {
    this.exports.infini2_seek_retry(this.ptr, direction(directionValue));
  }

  /** Evicts excess outer Buffer items without crossing Resident or a pin. */
  trimBuffer(directionValue: "before" | "after", maxItems: number): number {
    return this.exports.infini2_buffer_trim(
      this.ptr,
      direction(directionValue),
      Math.max(0, Math.floor(maxItems)),
    );
  }

  /** Returns rows required by the current main Layout target plus pins. */
  layoutRows(): RawRow[] {
    return this.readRows(this.exports.infini2_layout_query(this.ptr));
  }

  /** Returns the hidden-measure Layout rows for one candidate effect. */
  candidateRows(effect: number): RawRow[] {
    return this.readRows(
      this.exports.infini2_candidate_query(this.ptr, effect),
    );
  }

  /** Returns every row in an island for diagnostics/custom execution. */
  islandRows(island: number): RawRow[] {
    return this.readRows(this.exports.infini2_island_query(this.ptr, island));
  }

  /** Returns one island edge state. Invalid islands read as the ABI default. */
  islandEdge(island: number, directionValue: "before" | "after"): RawEdge {
    return this.exports.infini2_island_edge(
      this.ptr,
      island,
      direction(directionValue),
    ) as RawEdge;
  }

  /** ACKs exact mounted handles for a current Layout revision. */
  commitLayout(revision: number, handles: readonly number[]): boolean {
    this.pushHandles(handles);
    return Boolean(this.exports.infini2_layout_commit(this.ptr, revision));
  }

  /** Returns the most recently accepted physical Layout handle set. */
  committedHandles(): number[] {
    const count = this.exports.infini2_committed_count(this.ptr);
    return Array.from({ length: count }, (_, index) =>
      this.exports.infini2_committed_handle(this.ptr, index),
    );
  }

  /** Drains handles no longer referenced by any core-owned state. */
  takeReleased(): number[] {
    const output: number[] = [];
    for (;;) {
      const handle = this.exports.infini2_released_pop(this.ptr);
      if (handle === 0) return output;
      output.push(handle);
    }
  }

  /** Returns a point-in-time numeric geometry, topology, and Residency snapshot. */
  snapshot(): Readonly<RawSnapshot> {
    const main = this.exports.infini2_main_island(this.ptr);
    const visibleStart = this.exports.infini2_window_start(
      this.ptr,
      RawWindow.Visible,
    );
    const visibleEnd = this.exports.infini2_window_end(
      this.ptr,
      RawWindow.Visible,
    );
    const layoutStart = this.exports.infini2_window_start(
      this.ptr,
      RawWindow.LayoutTarget,
    );
    const layoutEnd = this.exports.infini2_window_end(
      this.ptr,
      RawWindow.LayoutTarget,
    );
    return {
      main,
      staleBefore: this.exports.infini2_stale_island(
        this.ptr,
        RawDirection.Before,
      ),
      staleAfter: this.exports.infini2_stale_island(
        this.ptr,
        RawDirection.After,
      ),
      surfaceExtent: this.exports.infini2_surface_extent(this.ptr),
      islandOrigin: this.exports.infini2_island_origin(this.ptr),
      blankBefore: this.exports.infini2_blank_extent(
        this.ptr,
        RawDirection.Before,
      ),
      blankAfter: this.exports.infini2_blank_extent(
        this.ptr,
        RawDirection.After,
      ),
      blankZone: this.exports.infini2_blank_zone(this.ptr) as RawBlankZone,
      visible: {
        start: visibleStart,
        end: visibleEnd,
        size: visibleEnd - visibleStart,
      },
      layoutTarget: {
        start: layoutStart,
        end: layoutEnd,
        size: layoutEnd - layoutStart,
      },
      mainLength: this.exports.infini2_main_len(this.ptr),
      mainExtent: this.exports.infini2_main_extent(this.ptr),
      residentStart: this.exports.infini2_resident_start(this.ptr),
      residentEnd: this.exports.infini2_resident_end(this.ptr),
      residentCount: this.exports.infini2_resident_count(this.ptr),
      residentFirst: this.exports.infini2_resident_handle(
        this.ptr,
        RawDirection.Before,
      ),
      residentLast: this.exports.infini2_resident_handle(
        this.ptr,
        RawDirection.After,
      ),
      bufferBefore: this.exports.infini2_buffer_count(
        this.ptr,
        RawDirection.Before,
      ),
      bufferAfter: this.exports.infini2_buffer_count(
        this.ptr,
        RawDirection.After,
      ),
      layoutRevision: this.exports.infini2_layout_revision(this.ptr),
    };
  }

  /** Returns cumulative sequence visit, mutation, and emitted-row counters. */
  diagnostics(): RawDiagnostics {
    return {
      visited: this.exports.infini2_diagnostics(this.ptr, 0),
      touched: this.exports.infini2_diagnostics(this.ptr, 1),
      emitted: this.exports.infini2_diagnostics(this.ptr, 2),
    };
  }

  /** Permanently destroys the lazily allocated Wasm engine. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pointer !== 0) this.exports.infini2_destroy(this.pointer);
    this.pointer = 0;
  }

  private pushItems(items: readonly RawItem[]): void {
    this.exports.infini2_items_begin(this.ptr);
    for (const item of items) {
      this.exports.infini2_items_push(
        this.ptr,
        item.handle,
        item.extent,
        Number(item.measured ?? false),
      );
    }
  }

  private pushHandles(handles: readonly number[]): void {
    this.exports.infini2_handles_begin(this.ptr);
    for (const handle of handles) {
      this.exports.infini2_handles_push(this.ptr, handle);
    }
  }

  private readRows(count: number): RawRow[] {
    return Array.from({ length: count }, (_, index) => ({
      handle: this.exports.infini2_row_handle(this.ptr, index),
      index: this.exports.infini2_row_index(this.ptr, index),
      start: this.exports.infini2_row_start(this.ptr, index),
      extent: this.exports.infini2_row_extent(this.ptr, index),
      measured: Boolean(this.exports.infini2_row_measured(this.ptr, index)),
    }));
  }

  private readCurrentEffect(): RawEffect {
    return {
      id: this.exports.infini2_effect_id(this.ptr),
      kind: this.exports.infini2_effect_kind(this.ptr),
      state: this.exports.infini2_effect_state(this.ptr),
      owner: this.exports.infini2_effect_owner(this.ptr),
      direction: this.exports.infini2_effect_direction(this.ptr),
      anchor: this.exports.infini2_effect_anchor(this.ptr),
      signedOffset: this.exports.infini2_effect_signed_offset(this.ptr),
      targetExtent: this.exports.infini2_effect_target_extent(this.ptr),
      targetToken: this.exports.infini2_effect_target_token(this.ptr),
    };
  }
}
