import {
  RawAlignment,
  RawBlankZone,
  RawCommitDisposition,
  RawDirection,
  RawEdge,
  RawEffectKind,
  RawEffectState,
  RawInfini2Engine,
  type RawEffect,
  type RawItem,
  type RawViewMetrics,
} from "../runtime/raw-engine";
import type {
  Infini2Alignment,
  Infini2Candidate,
  Infini2CandidatePreparer,
  Infini2ControllerConfig,
  Infini2Direction,
  Infini2ExternalInsert,
  Infini2Id,
  Infini2Measurement,
  Infini2Page,
  Infini2Phase,
  Infini2Snapshot,
  Infini2ViewInput,
} from "./contracts";

interface TargetIntent<TTarget> {
  target: TTarget;
  direction: Infini2Direction;
  alignment: Infini2Alignment;
}

interface ActiveEffect {
  raw: RawEffect;
  abort: AbortController;
}

type RetryIntent<TTarget> =
  | { kind: "bootstrap"; target?: TargetIntent<TTarget> }
  | { kind: "seek"; target: TargetIntent<TTarget> }
  | { kind: "predictive"; direction: Infini2Direction }
  | { kind: "fetch"; direction: Infini2Direction };

function toDirection(value: RawDirection): Infini2Direction {
  return value === RawDirection.Before ? "before" : "after";
}

function toRawAlignment(value: Infini2Alignment): RawAlignment {
  switch (value) {
    case "center":
      return RawAlignment.Center;
    case "end":
      return RawAlignment.End;
    case "nearest":
      return RawAlignment.Nearest;
    case "start":
      return RawAlignment.Start;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Effect runner and domain-object registry around the Rust engine. Async work
 * is owned by effect tickets; a newer scroll intent never globally invalidates
 * older useful results.
 *
 * @typeParam TItem - Provider-owned business object rendered by the UI.
 * @typeParam TCursor - Opaque Provider cursor.
 * @typeParam TId - Stable, never-reused business identity.
 * @typeParam TTarget - Application-level explicit jump target.
 *
 * @remarks
 * Constructing the controller is side-effect free and lazily initializes Wasm.
 * Call {@link start} after the owning lifecycle mounts and {@link dispose} when
 * it permanently unmounts. Configuration is treated as immutable.
 */
export class Infini2Controller<
  TItem,
  TCursor,
  TId extends Infini2Id,
  TTarget = never,
> {
  /** Optional label used to correlate adapter diagnostics. */
  debug: string | undefined;
  private readonly engine: RawInfini2Engine;
  private readonly listeners = new Set<() => void>();
  private readonly idToHandle = new Map<TId, number>();
  private readonly handleToId = new Map<number, TId>();
  private readonly items = new Map<number, TItem>();
  private readonly tombstones = new Set<number>();
  private readonly effects = new Map<number, ActiveEffect>();
  private readonly targetIntents = new Map<number, TargetIntent<TTarget>>();
  private nextHandle = 1;
  private nextTargetToken = 1;
  private foregroundEffect = 0;
  private retryIntent: RetryIntent<TTarget> | null = null;
  private revision = 0;
  private phase: Infini2Phase = { status: "dormant" };
  private candidate: Infini2Candidate<TItem, TId> | null = null;
  private candidatePreparer: Infini2CandidatePreparer<TItem, TId> | null = null;
  private view: RawViewMetrics;
  private snapshotCache: Infini2Snapshot<TItem, TId> | null = null;
  private needsViewAck = false;
  private engineReady = false;
  private layoutBeforeOverride: number | null;
  private layoutAfterOverride: number | null;
  private disposed = false;

  /**
   * Creates a dormant controller.
   *
   * @throws If `defaultItemEstimate` is not a finite positive number.
   */
  constructor(
    private readonly config: Infini2ControllerConfig<
      TItem,
      TCursor,
      TId,
      TTarget
    >,
  ) {
    if (
      !Number.isFinite(config.defaultItemEstimate) ||
      config.defaultItemEstimate <= 0
    ) {
      throw new Error("Infini2 defaultItemEstimate must be a positive number");
    }
    this.debug = config.debug;
    this.engine = new RawInfini2Engine(config.defaultItemEstimate);
    this.layoutBeforeOverride = config.layoutBefore ?? null;
    this.layoutAfterOverride = config.layoutAfter ?? null;
    this.view = {
      scroll: 0,
      viewport: 0,
      insetStart: 0,
      insetEnd: 0,
      layoutBefore: config.layoutBefore ?? 0,
      layoutAfter: config.layoutAfter ?? 0,
    };
  }

  /** Updates the optional adapter diagnostic label without affecting data state. */
  setDebug(debug: string | undefined): void {
    this.debug = debug;
  }

  /**
   * Subscribes to observable snapshot changes.
   *
   * @returns An idempotent unsubscribe callback.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Returns the current immutable observation.
   *
   * @remarks The same object is returned until the observable revision changes.
   * @throws If the controller has been disposed.
   */
  getSnapshot = (): Infini2Snapshot<TItem, TId> => {
    this.assertLive();
    return (this.snapshotCache ??= this.engineReady
      ? this.buildSnapshot()
      : this.buildDormantSnapshot());
  };

  /**
   * Installs the single hidden-mount candidate measurement hook.
   *
   * @returns A callback that removes this preparer only if it is still current.
   * @remarks Intended for a physical host; application code normally uses
   * {@link Infini2DomHost} indirectly instead.
   */
  setCandidatePreparer(
    preparer: Infini2CandidatePreparer<TItem, TId> | null,
  ): () => void {
    this.candidatePreparer = preparer;
    return () => {
      if (this.candidatePreparer === preparer) this.candidatePreparer = null;
    };
  }

  /**
   * Starts the initial bootstrap exactly once.
   *
   * @remarks Repeated calls after the first are no-ops. Provider work begins
   * asynchronously and is reflected through {@link getSnapshot}.
   */
  start(): void {
    this.assertLive();
    if (this.phase.status !== "dormant") return;
    this.ensureEngine();
    let targetToken = 0;
    if (this.config.initial.target !== undefined) {
      targetToken = this.storeTargetIntent({
        target: this.config.initial.target,
        direction: "after",
        alignment: this.config.initial.alignment ?? "start",
      });
    }
    this.phase = { status: "bootstrapping" };
    this.foregroundEffect = this.engine.beginBootstrap(targetToken);
    this.publish();
    this.pumpEffects();
  }

  /**
   * Submits the latest host-local scroll geometry and advances the work loop.
   *
   * @remarks Omitted insets retain their previous value. Explicit Layout
   * overscan becomes a persistent override; otherwise each side defaults to the
   * current physical viewport. A view submission also acknowledges an applied
   * scroll correction.
   */
  setView(input: Infini2ViewInput): void {
    this.assertLive();
    if (input.layoutBefore != null) {
      this.layoutBeforeOverride = input.layoutBefore;
    }
    if (input.layoutAfter != null) {
      this.layoutAfterOverride = input.layoutAfter;
    }
    const next: RawViewMetrics = {
      scroll: input.scroll,
      viewport: input.viewport,
      insetStart: input.paddingStart ?? this.view.insetStart,
      insetEnd: input.paddingEnd ?? this.view.insetEnd,
      layoutBefore: this.layoutBeforeOverride ?? input.viewport,
      layoutAfter: this.layoutAfterOverride ?? input.viewport,
    };
    const unchanged = Object.entries(next).every(
      ([key, value]) =>
        Math.abs(value - this.view[key as keyof RawViewMetrics]) < 0.01,
    );
    if (unchanged && !this.needsViewAck) return;
    this.needsViewAck = false;
    this.view = next;
    if (this.engineReady) this.engine.setView(this.view);
    this.publish();
    this.pumpEffects();
  }

  /**
   * Starts an explicit discontinuous seek without discarding reusable old work.
   *
   * @param target - Application target converted by `targetToCursor`.
   * @param options.direction - Relative side on which detached old content is
   * retained; defaults to `"after"`.
   * @param options.alignment - Placement inside VisibleWindow; defaults to start.
   * @returns The numeric effect ticket for diagnostics.
   * @throws If no `targetToCursor` function was configured.
   */
  jump(
    target: TTarget,
    options: {
      direction?: Infini2Direction;
      alignment?: Infini2Alignment;
    } = {},
  ): number {
    this.assertLive();
    this.ensureEngine();
    if (!this.config.targetToCursor) {
      throw new Error("Infini2 jump requires targetToCursor");
    }
    const direction = options.direction ?? "after";
    const targetToken = this.storeTargetIntent({
      target,
      direction,
      alignment: options.alignment ?? "start",
    });
    this.candidate = null;
    const effect = this.engine.beginSeek(direction, targetToken);
    this.foregroundEffect = effect;
    this.retryIntent = null;
    this.phase = { status: "seeking" };
    this.publish();
    this.pumpEffects();
    return effect;
  }

  /**
   * Applies an ordered external insertion next to a stable anchor.
   *
   * @returns Number of known-island insertions performed. A zero result means
   * the anchor did not currently identify a relevant known segment.
   */
  insertExternal(input: Infini2ExternalInsert<TItem, TId>): number {
    this.assertLive();
    this.ensureEngine();
    const anchor = this.ensureHandle(input.anchor);
    const items = this.registerItems(input.items);
    const changed = this.engine.externalInsert(anchor, input.side, items);
    this.drainReleased();
    this.publish();
    this.pumpEffects();
    return changed;
  }

  /**
   * Applies ordered external deletions and tombstones their stable identities.
   *
   * @returns Number of item occurrences removed across known islands.
   * @remarks A deleted identity cannot be revived by a late Provider response.
   */
  deleteExternal(ids: readonly TId[]): number {
    this.assertLive();
    this.ensureEngine();
    const handles = ids.map((id) => this.ensureHandle(id));
    for (const handle of handles) this.tombstones.add(handle);
    const changed = this.engine.externalDelete(handles);
    this.drainReleased();
    this.publish();
    this.pumpEffects();
    return changed;
  }

  /**
   * Replaces business objects without changing identity or content order.
   *
   * @remarks Height-changing updates are picked up by the DOM measurement loop.
   * A logical move must instead be represented as delete plus a new ID insert.
   */
  updateExternal(items: readonly TItem[]): void {
    this.assertLive();
    for (const item of items) {
      const id = this.config.ops.getId(item);
      const handle = this.ensureHandle(id);
      if (!this.tombstones.has(handle)) this.items.set(handle, item);
    }
    this.publish();
  }

  /**
   * Batch-submits finite positive block extents from a physical renderer.
   *
   * @returns Number of stored extents that actually changed.
   * @remarks Invalid, released, or unchanged measurements do not change layout.
   */
  measure(measurements: readonly Infini2Measurement[]): number {
    this.assertLive();
    this.ensureEngine();
    const changed = this.engine.measure(measurements);
    if (changed) {
      this.publish();
      this.pumpEffects();
    }
    return changed;
  }

  /**
   * Captures a semantic compensation anchor before geometry changes.
   *
   * @param ratio - Waterline inside VisibleWindow, clamped to `[0, 1]`.
   * @returns Non-zero anchored handle, or `0` when no item can be anchored.
   */
  captureAnchor(ratio = 0): number {
    this.assertLive();
    this.ensureEngine();
    return this.engine.captureAnchor(ratio);
  }

  /**
   * Reads the item at a VisibleWindow waterline without changing compensation.
   *
   * @param ratio - Waterline inside VisibleWindow, clamped to `[0, 1]`.
   * @returns The current layout item, or `null` when none covers the point.
   */
  getVisibleItem(
    ratio = 0,
  ): Infini2Snapshot<TItem, TId>["layoutItems"][number] | null {
    const snapshot = this.getSnapshot();
    const localPoint =
      snapshot.visible.start +
      snapshot.visible.size * Math.min(1, Math.max(0, ratio));
    return (
      snapshot.layoutItems.find((item) => {
        const start = item.start - snapshot.islandOrigin;
        return start <= localPoint && start + item.extent > localPoint;
      }) ?? null
    );
  }

  /**
   * Consumes the pending absolute host-local scroll target.
   *
   * @returns Target scroll in CSS pixels, or `null` when no correction is due.
   * @remarks Only the physical executor should call this. It must apply the
   * target and then call {@link setView} with the corrected metrics.
   */
  takeScrollCorrection(): number | null {
    this.assertLive();
    this.ensureEngine();
    const correction = this.engine.takeScrollCorrection();
    if (correction != null) this.needsViewAck = true;
    return correction;
  }

  /**
   * Acknowledges the exact handles mounted for a Layout revision.
   *
   * @returns `false` if the revision is stale or a handle is not in main.
   */
  commitLayout(revision: number, handles: readonly number[]): boolean {
    this.assertLive();
    this.ensureEngine();
    return this.engine.commitLayout(revision, handles);
  }

  /**
   * Pins or unpins an item so focus-bearing DOM survives virtual eviction.
   *
   * @returns Whether the pin set changed. Unknown/non-main IDs return `false`.
   */
  pin(id: TId, pinned = true): boolean {
    this.assertLive();
    this.ensureEngine();
    const handle = this.idToHandle.get(id);
    const changed = handle != null && this.engine.pin(handle, pinned);
    if (changed) this.publish();
    return changed;
  }

  /**
   * Explicitly evicts excess Buffer items from one main-island outer edge.
   *
   * @param maxItems - Maximum Buffer items to retain after trimming.
   * @returns Number of removed items.
   * @remarks Trimming never removes Resident items or crosses a pinned row. It
   * is an eviction policy, not part of the Buffer loading semantics.
   */
  trimBuffer(direction: Infini2Direction, maxItems: number): number {
    this.assertLive();
    this.ensureEngine();
    const changed = this.engine.trimBuffer(direction, maxItems);
    this.drainReleased();
    if (changed) this.publish();
    return changed;
  }

  /**
   * Reopens a direction previously proven exhausted and resumes filling.
   *
   * @remarks Use when the external content source creates a new boundary item.
   */
  reopen(direction: Infini2Direction): void {
    this.assertLive();
    this.ensureEngine();
    this.engine.reopen(direction);
    this.publish();
    this.pumpEffects();
  }

  /**
   * Retries the latched foreground intent with its original target semantics.
   *
   * @remarks Calling outside the `failed` phase is a no-op.
   */
  retry(): void {
    this.assertLive();
    if (this.phase.status !== "failed" || !this.retryIntent) return;
    const retry = this.retryIntent;
    this.retryIntent = null;
    if (retry.kind === "fetch") {
      this.phase = {
        status: "ready",
        empty: this.engine.snapshot().mainLength === 0,
      };
      this.engine.reopen(retry.direction);
    } else if (retry.kind === "predictive") {
      this.phase = { status: "seeking" };
      this.engine.retryPredictiveSeek(retry.direction);
    } else {
      const targetToken = retry.target
        ? this.storeTargetIntent(retry.target)
        : 0;
      this.foregroundEffect =
        retry.kind === "bootstrap"
          ? this.engine.beginBootstrap(targetToken)
          : this.engine.beginSeek(retry.target.direction, targetToken);
      this.phase = {
        status: retry.kind === "bootstrap" ? "bootstrapping" : "seeking",
      };
    }
    this.publish();
    this.pumpEffects();
  }

  /**
   * Applies candidate measurements and atomically activates that candidate.
   *
   * @returns Whether the effect still owned a committable candidate.
   * @remarks Normally invoked by the registered candidate preparer path. A late
   * or detached effect may safely return `false`.
   */
  async commitCandidate(
    effectId: number,
    measurements: readonly Infini2Measurement[] = [],
  ): Promise<boolean> {
    this.assertLive();
    this.ensureEngine();
    if (measurements.length) this.engine.measure(measurements);
    const committed = this.engine.commitCandidate(effectId);
    if (this.candidate?.effectId === effectId) this.candidate = null;
    if (committed && this.foregroundEffect === effectId) {
      this.foregroundEffect = 0;
      this.phase = {
        status: "ready",
        empty: this.engine.snapshot().mainLength === 0,
      };
    }
    this.drainReleased();
    this.publish();
    this.pumpEffects();
    return committed;
  }

  /**
   * Permanently releases requests, listeners, registries, and the core instance.
   *
   * @remarks Idempotent. Late Promise completions are ignored after disposal.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const active of this.effects.values()) active.abort.abort();
    this.effects.clear();
    this.listeners.clear();
    this.engine.dispose();
  }

  private pumpEffects(): void {
    let changed = false;
    for (const effect of this.engine.takeEffects()) {
      if (this.effects.has(effect.id)) continue;
      if (effect.kind === RawEffectKind.Seek && effect.targetToken === 0) {
        this.foregroundEffect = effect.id;
        this.phase = { status: "seeking" };
      }
      const active: ActiveEffect = {
        raw: effect,
        abort: new AbortController(),
      };
      this.effects.set(effect.id, active);
      changed = true;
      void this.runEffect(active);
    }
    if (changed) this.publish();
  }

  private async runEffect(active: ActiveEffect): Promise<void> {
    const effect = active.raw;
    try {
      const result = await this.resolveEffect(active);
      if (this.disposed) return;
      this.validatePage(effect, result.page);
      const registered = this.registerItems(
        result.page.items.filter(
          (item) =>
            !this.tombstones.has(
              this.ensureHandle(this.config.ops.getId(item)),
            ),
        ),
      );
      const targetHandle =
        result.targetId == null
          ? 0
          : (this.idToHandle.get(result.targetId) ?? 0);
      const disposition = this.engine.commitEffect({
        effect: effect.id,
        items: registered,
        exhaustedBefore: result.page.exhaustedBefore,
        exhaustedAfter: result.page.exhaustedAfter,
        targetHandle,
        alignment: toRawAlignment(result.alignment),
      });
      if (disposition === RawCommitDisposition.Rejected) {
        throw new Error("Infini2 rejected an out-of-order provider slice");
      }
      if (disposition === RawCommitDisposition.Candidate) {
        await this.prepareCandidate(effect.id, result.page);
      } else if (
        this.foregroundEffect === effect.id &&
        effect.kind === RawEffectKind.Seek
      ) {
        this.foregroundEffect = 0;
        this.phase = {
          status: "ready",
          empty: this.engine.snapshot().mainLength === 0,
        };
      }
      this.drainReleased();
      this.publish();
      this.pumpEffects();
    } catch (error) {
      if (this.disposed || active.abort.signal.aborted) return;
      const failure = asError(error);
      const live = this.engine.effect(effect.id);
      const foreground =
        effect.kind === RawEffectKind.EdgeFetch
          ? this.engine.effectAffectsMain(effect.id)
          : this.foregroundEffect === effect.id;
      const detached =
        live?.state === RawEffectState.Detached ||
        (effect.kind !== RawEffectKind.EdgeFetch && !foreground);
      const backgroundEdge =
        effect.kind === RawEffectKind.EdgeFetch && !foreground;
      this.engine.rejectEffect(effect.id);
      if (this.candidate?.effectId === effect.id) this.candidate = null;
      this.drainReleased();
      const direction = toDirection(effect.direction);
      const operation =
        effect.kind === RawEffectKind.Bootstrap
          ? "bootstrap"
          : effect.kind === RawEffectKind.EdgeFetch
            ? "fetch"
            : "seek";
      this.config.onError?.(failure, {
        operation,
        direction,
        foreground,
      });
      if (detached || backgroundEdge) {
        // Detached activation work is no longer allowed to affect visible
        // phase, but successful late results would still have been reusable.
      } else if (effect.kind === RawEffectKind.Bootstrap) {
        this.foregroundEffect = 0;
        this.retryIntent = {
          kind: "bootstrap",
          target: effect.targetToken
            ? this.targetIntents.get(effect.targetToken)
            : undefined,
        };
        this.phase = {
          status: "failed",
          operation: "bootstrap",
          error: failure,
        };
      } else if (effect.kind === RawEffectKind.Seek) {
        const target = this.targetIntents.get(effect.targetToken);
        this.retryIntent = target
          ? { kind: "seek", target }
          : { kind: "predictive", direction };
        this.foregroundEffect = 0;
        this.phase = {
          status: "failed",
          operation: "seek",
          direction,
          error: failure,
        };
      } else {
        this.retryIntent = { kind: "fetch", direction };
        this.phase = {
          status: "failed",
          operation: "fetch",
          direction,
          error: failure,
        };
      }
      this.publish();
    } finally {
      this.effects.delete(effect.id);
      if (effect.targetToken) this.targetIntents.delete(effect.targetToken);
      this.publish();
    }
  }

  private async resolveEffect(active: ActiveEffect): Promise<{
    page: Infini2Page<TItem>;
    targetId?: TId;
    alignment: Infini2Alignment;
  }> {
    const effect = active.raw;
    const direction = toDirection(effect.direction);
    if (effect.kind === RawEffectKind.EdgeFetch) {
      const anchor = this.items.get(effect.anchor);
      if (!anchor) throw new Error("Infini2 edge fetch lost its anchor item");
      return {
        page: await this.config.provider.fetch({
          cursor: this.config.ops.getCursor(anchor),
          direction,
          targetSize: effect.targetExtent,
          signal: active.abort.signal,
        }),
        alignment: "start",
      };
    }

    const targetIntent = this.targetIntents.get(effect.targetToken);
    if (targetIntent) {
      if (!this.config.targetToCursor) {
        throw new Error("Infini2 target seek requires targetToCursor");
      }
      const page = await this.config.provider.bootstrap({
        cursor: this.config.targetToCursor(targetIntent.target),
        targetSize: effect.targetExtent,
        signal: active.abort.signal,
      });
      return {
        page,
        targetId:
          this.config.locateTarget?.(page.items, targetIntent.target) ??
          undefined,
        alignment: targetIntent.alignment,
      };
    }

    if (effect.kind === RawEffectKind.Bootstrap) {
      const page = await this.config.provider.bootstrap({
        cursor: this.config.initial.cursor,
        targetSize: effect.targetExtent,
        signal: active.abort.signal,
      });
      return {
        page,
        alignment: this.config.initial.alignment ?? "start",
      };
    }

    const anchor = this.items.get(effect.anchor);
    if (!anchor) throw new Error("Infini2 predictive seek lost its anchor");
    if (!this.config.provider.locateOffset) {
      throw new Error("Infini2 provider does not implement locateOffset");
    }
    const located = await this.config.provider.locateOffset({
      anchor,
      signedItemOffset: effect.signedOffset,
      signal: active.abort.signal,
    });
    const page = await this.config.provider.bootstrap({
      cursor: located.cursor,
      targetSize: effect.targetExtent,
      signal: active.abort.signal,
    });
    return {
      page,
      targetId: located.targetId,
      alignment: "center",
    };
  }

  private async prepareCandidate(
    effectId: number,
    page: Infini2Page<TItem>,
  ): Promise<void> {
    const rows = this.engine.candidateRows(effectId);
    const items = rows.flatMap((row) => {
      const item = this.items.get(row.handle);
      const id = this.handleToId.get(row.handle);
      return item == null || id == null
        ? []
        : [
            {
              handle: row.handle,
              id,
              item,
              index: row.index,
              start: row.start,
              extent: row.extent,
              measured: row.measured,
            },
          ];
    });
    const candidate: Infini2Candidate<TItem, TId> = {
      effectId,
      items,
    };
    this.candidate = candidate;
    this.publish();
    const measurements = this.candidatePreparer
      ? await this.candidatePreparer(candidate)
      : [];
    const measured = new Map(
      measurements
        .filter(
          (measurement) =>
            Number.isFinite(measurement.extent) && measurement.extent > 0,
        )
        .map((measurement) => [measurement.handle, measurement.extent]),
    );
    const candidateExtent = candidate.items.reduce(
      (total, item) => total + (measured.get(item.handle) ?? item.extent),
      0,
    );
    const visibleExtent = Math.max(
      0,
      this.view.viewport - this.view.insetStart - this.view.insetEnd,
    );
    if (
      candidateExtent + 0.5 < visibleExtent &&
      (!page.exhaustedBefore || !page.exhaustedAfter)
    ) {
      throw new Error(
        "Infini2 provider underfilled bootstrap before covering VisibleWindow",
      );
    }
    await this.commitCandidate(effectId, measurements);
  }

  private registerItems(items: readonly TItem[]): RawItem[] {
    const output: RawItem[] = [];
    for (const item of items) {
      const id = this.config.ops.getId(item);
      const handle = this.ensureHandle(id);
      if (this.tombstones.has(handle)) continue;
      this.items.set(handle, item);
      const estimated = this.config.estimateSize(item);
      output.push({
        handle,
        extent:
          Number.isFinite(estimated) && estimated > 0
            ? estimated
            : this.config.defaultItemEstimate,
      });
    }
    return output;
  }

  private ensureHandle(id: TId): number {
    const existing = this.idToHandle.get(id);
    if (existing != null) return existing;
    if (this.nextHandle > 0xffff_ffff) {
      throw new Error("Infini2 exhausted its stable handle namespace");
    }
    const handle = this.nextHandle++;
    this.idToHandle.set(id, handle);
    this.handleToId.set(handle, id);
    return handle;
  }

  private validatePage(effect: RawEffect, page: Infini2Page<TItem>): void {
    const seen = new Set<TId>();
    for (const item of page.items) {
      const id = this.config.ops.getId(item);
      if (seen.has(id)) {
        throw new Error(
          `Infini2 provider returned duplicate stable id ${String(id)}`,
        );
      }
      seen.add(id);
    }
    if (page.items.length !== 0) return;
    if (effect.kind === RawEffectKind.EdgeFetch) {
      const exhausted =
        effect.direction === RawDirection.Before
          ? page.exhaustedBefore
          : page.exhaustedAfter;
      if (!exhausted) {
        throw new Error("Infini2 provider returned an empty, open edge page");
      }
      return;
    }
    if (!page.exhaustedBefore || !page.exhaustedAfter) {
      throw new Error(
        "Infini2 provider returned an empty, open bootstrap page",
      );
    }
  }

  private storeTargetIntent(intent: TargetIntent<TTarget>): number {
    const token = this.nextTargetToken++;
    this.targetIntents.set(token, intent);
    return token;
  }

  private drainReleased(): void {
    for (const handle of this.engine.takeReleased()) {
      this.items.delete(handle);
    }
  }

  private publish(): void {
    if (this.disposed) return;
    this.revision += 1;
    this.snapshotCache = null;
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): Infini2Snapshot<TItem, TId> {
    const raw = this.engine.snapshot();
    const mainItems = (
      raw.main === 0 ? [] : this.engine.islandRows(raw.main)
    ).flatMap((row) => {
      const item = this.items.get(row.handle);
      const id = this.handleToId.get(row.handle);
      return item == null || id == null
        ? []
        : [
            {
              handle: row.handle,
              id,
              item,
              index: row.index,
              start: raw.islandOrigin + row.start,
              extent: row.extent,
              measured: row.measured,
            },
          ];
    });
    const layoutItems = this.engine.layoutRows().flatMap((row) => {
      const item = this.items.get(row.handle);
      const id = this.handleToId.get(row.handle);
      return item == null || id == null
        ? []
        : [
            {
              handle: row.handle,
              id,
              item,
              index: row.index,
              start: raw.islandOrigin + row.start,
              extent: row.extent,
              measured: row.measured,
            },
          ];
    });
    const active = [...this.effects.values()];
    const residentFirst = this.handleToId.get(raw.residentFirst);
    const residentLast = this.handleToId.get(raw.residentLast);
    const loadingBefore = active.some(
      ({ raw: effect }) =>
        effect.kind === RawEffectKind.EdgeFetch &&
        effect.direction === RawDirection.Before,
    );
    const loadingAfter = active.some(
      ({ raw: effect }) =>
        effect.kind === RawEffectKind.EdgeFetch &&
        effect.direction === RawDirection.After,
    );
    return Object.freeze({
      revision: this.revision,
      phase: this.phase,
      layoutRevision: raw.layoutRevision,
      layoutItems: Object.freeze(layoutItems),
      candidate: this.candidate,
      surfaceExtent: raw.surfaceExtent,
      islandOrigin: raw.islandOrigin,
      visible: raw.visible,
      layoutTarget: raw.layoutTarget,
      blankZone: raw.blankZone,
      residentCount: raw.residentCount,
      residentRange:
        residentFirst != null && residentLast != null
          ? Object.freeze({ first: residentFirst, last: residentLast })
          : null,
      bufferBefore: raw.bufferBefore,
      bufferAfter: raw.bufferAfter,
      mainLength: raw.mainLength,
      mainExtent: raw.mainExtent,
      mainItems: Object.freeze(mainItems),
      mainIsland: raw.main,
      staleBeforeIsland: raw.staleBefore,
      staleAfterIsland: raw.staleAfter,
      exhaustedBefore:
        raw.main !== 0 &&
        this.engine.islandEdge(raw.main, "before") === RawEdge.Exhausted,
      exhaustedAfter:
        raw.main !== 0 &&
        this.engine.islandEdge(raw.main, "after") === RawEdge.Exhausted,
      loadingBefore,
      loadingAfter,
      effects: Object.freeze(
        active.map(({ raw: effect }) => ({
          id: effect.id,
          kind: effect.kind,
          direction: toDirection(effect.direction),
          detached:
            this.engine.effect(effect.id)?.state === RawEffectState.Detached,
        })),
      ),
      getItem: (handle: number) => this.items.get(handle),
      getHandle: (id: TId) => this.idToHandle.get(id),
    });
  }

  private buildDormantSnapshot(): Infini2Snapshot<TItem, TId> {
    const visibleStart = this.view.scroll + this.view.insetStart;
    const visibleSize = Math.max(
      0,
      this.view.viewport - this.view.insetStart - this.view.insetEnd,
    );
    const visible = Object.freeze({
      start: visibleStart,
      end: visibleStart + visibleSize,
      size: visibleSize,
    });
    const layoutStart = visible.start - this.view.layoutBefore;
    const layoutEnd = visible.end + this.view.layoutAfter;
    return Object.freeze({
      revision: this.revision,
      phase: this.phase,
      layoutRevision: 0,
      layoutItems: Object.freeze([]),
      candidate: null,
      surfaceExtent: 0,
      islandOrigin: 0,
      visible,
      layoutTarget: Object.freeze({
        start: layoutStart,
        end: layoutEnd,
        size: Math.max(0, layoutEnd - layoutStart),
      }),
      blankZone: RawBlankZone.None,
      residentCount: 0,
      residentRange: null,
      bufferBefore: 0,
      bufferAfter: 0,
      mainLength: 0,
      mainExtent: 0,
      mainItems: Object.freeze([]),
      mainIsland: 0,
      staleBeforeIsland: 0,
      staleAfterIsland: 0,
      exhaustedBefore: false,
      exhaustedAfter: false,
      loadingBefore: false,
      loadingAfter: false,
      effects: Object.freeze([]),
      getItem: (handle: number) => this.items.get(handle),
      getHandle: (id: TId) => this.idToHandle.get(id),
    });
  }

  private ensureEngine(): void {
    if (this.engineReady) return;
    this.engine.configure({
      residentBefore: this.config.residentBefore ?? 16,
      residentAfter: this.config.residentAfter ?? 16,
      staleMissLimit: this.config.staleMissLimit ?? 3,
    });
    this.engine.setView(this.view);
    this.engineReady = true;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("Infini2 controller has been disposed");
  }
}
