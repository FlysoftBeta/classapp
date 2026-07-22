use std::collections::{HashMap, HashSet, VecDeque};

use crate::sequence::Sequence;
use crate::types::{
    Alignment, BlankZone, CommitDisposition, Diagnostics, Direction, EdgeState, EffectId,
    EffectKind, EffectState, Handle, IslandId, IslandRole, Item, ItemSnapshot, ViewMetrics, Window,
    WindowKind, INVALID_EFFECT, INVALID_HANDLE, INVALID_ISLAND,
};

const DEFAULT_BLANK_VIEWPORTS: f64 = 20.0;
const DEFAULT_STALE_MISS_LIMIT: u32 = 3;

/// Read-only public state of one known contiguous item island.
///
/// The sequence itself is intentionally private so callers cannot bypass stable
/// ordering, merge, journal, anchor, or layout-revision invariants.
pub struct Island {
    /// Non-zero identity of this island.
    pub id: IslandId,
    /// Current topology role relative to the visible main island.
    pub role: IslandRole,
    sequence: Sequence,
    /// Whether content may exist before this island.
    pub before: EdgeState,
    /// Whether content may exist after this island.
    pub after: EdgeState,
    /// Inclusive zero-based Resident start rank.
    pub resident_start: u32,
    /// Exclusive zero-based Resident end rank.
    pub resident_end: u32,
    /// Relevant successful loads seen without a common merge anchor.
    pub miss_count: u32,
}

impl Island {
    fn new(id: IslandId, role: IslandRole) -> Self {
        Self {
            id,
            role,
            sequence: Sequence::new(),
            before: EdgeState::Open,
            after: EdgeState::Open,
            resident_start: 0,
            resident_end: 0,
            miss_count: 0,
        }
    }

    /// Returns the number of known items in this island.
    pub fn len(&self) -> u32 {
        self.sequence.len()
    }

    /// Returns whether this island contains no items.
    pub fn is_empty(&self) -> bool {
        self.sequence.is_empty()
    }

    /// Returns the aggregate estimated/measured item extent.
    pub fn extent(&self) -> f64 {
        self.sequence.total_extent()
    }

    /// Returns the content-boundary state in one direction.
    pub fn edge(&self, direction: Direction) -> EdgeState {
        match direction {
            Direction::Before => self.before,
            Direction::After => self.after,
        }
    }

    fn set_edge(&mut self, direction: Direction, state: EdgeState) {
        match direction {
            Direction::Before => self.before = state,
            Direction::After => self.after = state,
        }
    }

    /// Returns known items outside Resident on one side.
    ///
    /// A non-zero result is the Buffer waterline that suppresses another fetch
    /// in that direction; it is not a separate storage container or capacity.
    pub fn buffer_count(&self, direction: Direction) -> u32 {
        match direction {
            Direction::Before => self.resident_start.min(self.len()),
            Direction::After => self.len().saturating_sub(self.resident_end.min(self.len())),
        }
    }

    /// Returns the dynamically computed Resident item count.
    pub fn resident_count(&self) -> u32 {
        self.resident_end
            .min(self.len())
            .saturating_sub(self.resident_start.min(self.len()))
    }
}

#[derive(Clone, Copy, Debug)]
/// Immutable snapshot of one live asynchronous work ticket.
pub struct Effect {
    /// Non-zero work identity.
    pub id: EffectId,
    /// Requested Provider operation.
    pub kind: EffectKind,
    /// Current work lifecycle state.
    pub state: EffectState,
    /// Island against which the request began, or invalid for first bootstrap.
    pub owner: IslandId,
    /// Content-order direction associated with the work.
    pub direction: Direction,
    /// Boundary or prediction anchor handle, or invalid when not applicable.
    pub anchor: Handle,
    /// Estimated relative item offset for predictive seeking.
    pub signed_offset: i64,
    /// Desired Provider page coverage in logical pixels.
    pub target_extent: f64,
    /// Opaque token owned and interpreted by the outer executor.
    pub target_token: u32,
    /// Exact candidate target handle selected by the executor, or invalid.
    pub target_handle: Handle,
    /// Desired target placement when the candidate activates.
    pub alignment: Alignment,
    stale_direction: Direction,
    journal_cursor: u64,
}

#[derive(Clone, Debug)]
enum JournalMutation {
    Insert {
        anchor: Handle,
        side: Direction,
        items: Vec<Item>,
    },
    Delete {
        handles: Vec<Handle>,
    },
}

#[derive(Clone, Debug)]
struct JournalEntry {
    cursor: u64,
    mutation: JournalMutation,
}

#[derive(Clone, Copy, Debug)]
struct Anchor {
    handle: Handle,
    item_offset: f64,
    visible_offset: f64,
}

/// Platform-independent Infini2 state machine and geometric sequence engine.
///
/// `Engine` emits effects but performs no I/O. The outer executor owns stable-ID
/// mapping, Provider calls, hidden measurement, DOM/native commits, and physical
/// scroll writes. Methods are synchronous and deterministic for a given event
/// order; Provider completion order does not act as a global generation.
pub struct Engine {
    default_extent: f64,
    blank_viewports: f64,
    stale_miss_limit: u32,
    resident_before: u32,
    resident_after: u32,
    view: ViewMetrics,
    islands: HashMap<IslandId, Island>,
    main: Option<IslandId>,
    stale_before: Option<IslandId>,
    stale_after: Option<IslandId>,
    candidates: HashMap<EffectId, IslandId>,
    aliases: HashMap<IslandId, IslandId>,
    next_island: IslandId,
    effects: HashMap<EffectId, Effect>,
    effect_outbox: VecDeque<EffectId>,
    blocked_edges: HashSet<(IslandId, Direction)>,
    blocked_seeks: HashSet<(IslandId, Direction)>,
    next_effect: EffectId,
    journal: VecDeque<JournalEntry>,
    journal_cursor: u64,
    layout_revision: u32,
    layout_rows: Vec<ItemSnapshot>,
    committed_revision: u32,
    committed_handles: Vec<Handle>,
    pinned: HashSet<Handle>,
    anchor: Option<Anchor>,
    scroll_correction: Option<f64>,
    released: VecDeque<Handle>,
    diagnostics: Diagnostics,
}

impl Engine {
    /// Creates an empty engine with a finite positive fallback item extent.
    ///
    /// Invalid fallback values normalize to `1.0`. Allocation of business items
    /// and execution of bootstrap remain the caller's responsibility.
    pub fn new(default_extent: f64) -> Self {
        Self {
            default_extent: if default_extent.is_finite() && default_extent > 0.0 {
                default_extent
            } else {
                1.0
            },
            blank_viewports: DEFAULT_BLANK_VIEWPORTS,
            stale_miss_limit: DEFAULT_STALE_MISS_LIMIT,
            resident_before: 0,
            resident_after: 0,
            view: ViewMetrics::default(),
            islands: HashMap::new(),
            main: None,
            stale_before: None,
            stale_after: None,
            candidates: HashMap::new(),
            aliases: HashMap::new(),
            next_island: 1,
            effects: HashMap::new(),
            effect_outbox: VecDeque::new(),
            blocked_edges: HashSet::new(),
            blocked_seeks: HashSet::new(),
            next_effect: 1,
            journal: VecDeque::new(),
            journal_cursor: 0,
            layout_revision: 1,
            layout_rows: Vec::new(),
            committed_revision: 0,
            committed_handles: Vec::new(),
            pinned: HashSet::new(),
            anchor: None,
            scroll_correction: None,
            released: VecDeque::new(),
            diagnostics: Diagnostics::default(),
        }
    }

    /// Clears all islands, effects, journals, layout, pins, and anchor state.
    ///
    /// Handles no longer referenced after the reset are queued for
    /// [`Self::pop_released`]. Configuration and view metrics are retained.
    pub fn reset(&mut self) {
        let all_handles = self
            .islands
            .values()
            .flat_map(|island| {
                let mut diagnostics = Diagnostics::default();
                island
                    .sequence
                    .snapshots(&mut diagnostics)
                    .into_iter()
                    .map(|row| row.handle)
                    .collect::<Vec<_>>()
            })
            .collect::<HashSet<_>>();
        self.islands.clear();
        self.main = None;
        self.stale_before = None;
        self.stale_after = None;
        self.candidates.clear();
        self.aliases.clear();
        self.effects.clear();
        self.effect_outbox.clear();
        self.blocked_edges.clear();
        self.blocked_seeks.clear();
        self.journal.clear();
        self.committed_handles.clear();
        self.pinned.clear();
        self.anchor = None;
        self.scroll_correction = None;
        self.layout_rows.clear();
        self.bump_layout_revision();
        self.released.extend(all_handles);
    }

    /// Sets relevant no-anchor loads allowed before a stale island is dropped.
    ///
    /// The value is clamped to at least one.
    pub fn set_stale_miss_limit(&mut self, value: u32) {
        self.stale_miss_limit = value.max(1);
    }

    /// Sets item-count padding around Layout-intersecting Resident base items.
    ///
    /// These values are not a total Resident cap. Resident remains dynamic.
    pub fn set_resident_padding(&mut self, before: u32, after: u32) {
        self.resident_before = before;
        self.resident_after = after;
        self.settle();
    }

    /// Submits host-local geometry, normalizes it, and advances the work loop.
    ///
    /// Viewport or inset changes preserve a semantic top anchor. Calling this
    /// after a physical scroll write acknowledges the pending correction.
    pub fn set_view(&mut self, view: ViewMetrics) {
        let normalized = view.normalized();
        let preserve_anchor = self.main.is_some()
            && self.scroll_correction.is_none()
            && (self.view.viewport != normalized.viewport
                || self.view.inset_start != normalized.inset_start
                || self.view.inset_end != normalized.inset_end);
        if preserve_anchor {
            self.capture_anchor(0.0);
        }
        if self.view != normalized {
            self.view = normalized;
            self.bump_layout_revision();
        }
        if preserve_anchor {
            self.restore_anchor();
        }
        self.settle();
    }

    /// Returns the most recently normalized host view.
    pub fn view(&self) -> ViewMetrics {
        self.view
    }

    /// Returns the current main island identity, or [`INVALID_ISLAND`].
    pub fn main_id(&self) -> IslandId {
        self.main.unwrap_or(INVALID_ISLAND)
    }

    /// Returns the stale island identity on one side, or [`INVALID_ISLAND`].
    pub fn stale_id(&self, direction: Direction) -> IslandId {
        match direction {
            Direction::Before => self.stale_before,
            Direction::After => self.stale_after,
        }
        .unwrap_or(INVALID_ISLAND)
    }

    /// Borrows read-only state for a live island identity.
    pub fn island(&self, id: IslandId) -> Option<&Island> {
        self.islands.get(&id)
    }

    /// Returns the topology role of a live island.
    pub fn island_role(&self, id: IslandId) -> Option<IslandRole> {
        self.islands.get(&id).map(|island| island.role)
    }

    /// Returns every row of an island in content order using internal scratch storage.
    ///
    /// Primarily intended for diagnostics and raw executors. A later row query
    /// replaces the scratch result.
    pub fn island_rows(&mut self, id: IslandId) -> &[ItemSnapshot] {
        self.layout_rows.clear();
        if let Some(island) = self.islands.get(&id) {
            self.layout_rows = island.sequence.snapshots(&mut self.diagnostics);
        }
        &self.layout_rows
    }

    /// Returns one content-boundary state, or `None` for an unknown island.
    pub fn island_edge(&self, id: IslandId, direction: Direction) -> Option<EdgeState> {
        self.islands.get(&id).map(|island| island.edge(direction))
    }

    /// Returns main-island Resident as an inclusive-start, exclusive-end rank pair.
    pub fn resident_bounds(&self) -> (u32, u32) {
        self.main()
            .map(|main| (main.resident_start, main.resident_end))
            .unwrap_or((0, 0))
    }

    /// Borrows the current main island, if activation has completed.
    pub fn main(&self) -> Option<&Island> {
        self.main.and_then(|id| self.islands.get(&id))
    }

    /// Returns the current main-island item count, or zero.
    pub fn main_len(&self) -> u32 {
        self.main().map_or(0, Island::len)
    }

    /// Returns the aggregate main-island extent, or zero.
    pub fn main_extent(&self) -> f64 {
        self.main().map_or(0.0, Island::extent)
    }

    /// Returns the fixed twenty-viewport runway for an open edge, otherwise zero.
    pub fn blank_extent(&self, direction: Direction) -> f64 {
        let open = self
            .main()
            .is_some_and(|island| island.edge(direction) == EdgeState::Open);
        if open {
            self.view.viewport * self.blank_viewports
        } else {
            0.0
        }
    }

    /// Returns the main island's start coordinate inside the physical surface.
    pub fn island_origin(&self) -> f64 {
        self.blank_extent(Direction::Before)
    }

    /// Returns before Blank plus main extent plus after Blank.
    pub fn surface_extent(&self) -> f64 {
        self.blank_extent(Direction::Before)
            + self.main_extent()
            + self.blank_extent(Direction::After)
    }

    /// Returns the selected extent-based window in main-island-local coordinates.
    pub fn window(&self, kind: WindowKind) -> Window {
        match kind {
            WindowKind::Visible => self.visible_window(),
            WindowKind::LayoutTarget => self.layout_target(),
            WindowKind::LayoutCommitted => self.committed_window(),
        }
    }

    /// Returns the unobscured viewport in main-island-local coordinates.
    ///
    /// A pending correction target participates in this calculation instead of
    /// stale physical scroll, preventing spurious work scheduling.
    pub fn visible_window(&self) -> Window {
        let scroll = self.scroll_correction.unwrap_or(self.view.scroll);
        let start = scroll - self.island_origin() + self.view.inset_start;
        Window::new(start, start + self.view.visible_extent())
    }

    /// Returns Visible expanded by configured before/after pixel overscan.
    pub fn layout_target(&self) -> Window {
        let visible = self.visible_window();
        Window::new(
            visible.start - self.view.layout_before,
            visible.end + self.view.layout_after,
        )
    }

    /// Classifies whether the visible waterline requires predictive seeking.
    ///
    /// The first VisibleWindow-sized runway adjacent to main remains continuous
    /// and is serviced by ordinary edge fetching.
    pub fn blank_zone(&self) -> BlankZone {
        let Some(main) = self.main() else {
            return BlankZone::None;
        };
        if main.is_empty() {
            return BlankZone::None;
        }
        let visible = self.visible_window();
        let waterline = visible.start + visible.extent() * 0.5;
        // The first visible-window-sized runway outside the loaded island is
        // still the Blank Resident Zone: it advances through the ordinary
        // edge-fetch work loop. Only farther travel is discrete/predictive.
        let resident_runway = visible.extent();
        if waterline < -resident_runway {
            BlankZone::Before
        } else if waterline >= main.extent() + resident_runway {
            BlankZone::After
        } else {
            BlankZone::None
        }
    }

    /// Returns the current dynamic main Resident item count.
    pub fn resident_count(&self) -> u32 {
        self.main().map_or(0, Island::resident_count)
    }

    /// Returns the first or last Resident handle, or [`INVALID_HANDLE`].
    pub fn resident_handle(&mut self, direction: Direction) -> Handle {
        let Some(main_id) = self.main else {
            return INVALID_HANDLE;
        };
        let Some(main) = self.islands.get(&main_id) else {
            return INVALID_HANDLE;
        };
        if main.resident_count() == 0 {
            return INVALID_HANDLE;
        }
        let index = match direction {
            Direction::Before => main.resident_start,
            Direction::After => main.resident_end.saturating_sub(1),
        };
        main.sequence
            .handle_at(index, &mut self.diagnostics)
            .unwrap_or(INVALID_HANDLE)
    }

    /// Returns main items outside Resident on one side.
    pub fn buffer_count(&self, direction: Direction) -> u32 {
        self.main()
            .map_or(0, |island| island.buffer_count(direction))
    }

    /// Starts initial activation and returns its non-zero effect identity.
    ///
    /// `target_token` is opaque to the core and may be zero when no explicit
    /// application target exists. Any older activation is detached, not globally
    /// invalidated.
    pub fn begin_bootstrap(&mut self, target_token: u32) -> EffectId {
        if self
            .effects
            .values()
            .any(|effect| effect.kind == EffectKind::Bootstrap)
        {
            return INVALID_EFFECT;
        }
        self.create_effect(
            EffectKind::Bootstrap,
            self.main.unwrap_or(INVALID_ISLAND),
            Direction::After,
            INVALID_HANDLE,
            0,
            self.target_extent(),
            target_token,
        )
    }

    /// Starts a discontinuous explicit seek and returns its effect identity.
    ///
    /// `direction` controls the relative side on which reusable old content is
    /// retained. The outer executor resolves the opaque `target_token`.
    pub fn begin_explicit_seek(&mut self, direction: Direction, target_token: u32) -> EffectId {
        // Activation intents supersede one another, but their work is detached
        // rather than globally invalidated. A late useful result can still be
        // retained as the corresponding stale island.
        let superseded = self
            .effects
            .values()
            .filter(|effect| {
                matches!(effect.kind, EffectKind::Bootstrap | EffectKind::Seek)
                    && effect.state != EffectState::Detached
            })
            .map(|effect| {
                let stale_direction =
                    if effect.kind == EffectKind::Seek && effect.direction == direction {
                        direction.opposite()
                    } else {
                        effect.direction
                    };
                (effect.id, stale_direction)
            })
            .collect::<Vec<_>>();
        for (effect, stale_direction) in superseded {
            self.detach_effect_as(effect, stale_direction);
        }
        let anchor = self.boundary_handle(direction);
        self.create_effect(
            EffectKind::Seek,
            self.main.unwrap_or(INVALID_ISLAND),
            direction,
            anchor,
            0,
            self.target_extent(),
            target_token,
        )
    }

    /// Pops the next newly scheduled effect from the executor outbox.
    ///
    /// The returned effect remains queryable until committed or rejected.
    pub fn pop_effect(&mut self) -> Option<Effect> {
        while let Some(id) = self.effect_outbox.pop_front() {
            if let Some(effect) = self.effects.get(&id) {
                return Some(*effect);
            }
        }
        None
    }

    /// Returns a copy of a still-live effect ticket.
    pub fn effect(&self, id: EffectId) -> Option<Effect> {
        self.effects.get(&id).copied()
    }

    /// Returns whether an effect owner currently resolves to the main island.
    pub fn effect_affects_main(&self, id: EffectId) -> bool {
        let Some(effect) = self.effects.get(&id) else {
            return false;
        };
        self.resolve_owner(effect.owner) == self.main
    }

    /// Marks an activation effect as no longer able to replace foreground.
    ///
    /// A successful late result may still be retained as a stale island. Edge
    /// fetches cannot be detached with this operation.
    pub fn detach_effect(&mut self, id: EffectId) -> bool {
        let Some(direction) = self.effects.get(&id).map(|effect| effect.direction) else {
            return false;
        };
        self.detach_effect_as(id, direction)
    }

    fn detach_effect_as(&mut self, id: EffectId, stale_direction: Direction) -> bool {
        let Some(effect) = self.effects.get_mut(&id) else {
            return false;
        };
        if effect.kind == EffectKind::EdgeFetch {
            return false;
        }
        effect.state = EffectState::Detached;
        effect.stale_direction = stale_direction;
        if let Some(candidate_id) = self.candidates.remove(&id) {
            self.store_stale(candidate_id, stale_direction);
            self.finish_effect(id);
        }
        true
    }

    /// Rejects and finishes a live effect.
    ///
    /// Edge-fetch rejection latches the resolved owner/direction frontier until
    /// it is explicitly reopened, preventing automatic retry loops.
    pub fn reject_effect(&mut self, id: EffectId) -> bool {
        let Some(effect) = self.effects.get(&id).copied() else {
            return false;
        };
        if effect.kind == EffectKind::EdgeFetch {
            if let Some(owner) = self.resolve_owner(effect.owner) {
                self.blocked_edges.insert((owner, effect.direction));
            }
        } else if effect.kind == EffectKind::Seek && effect.target_token == 0 {
            if let Some(owner) = self.resolve_owner(effect.owner) {
                self.blocked_seeks.insert((owner, effect.direction));
            }
        }
        if let Some(candidate) = self.candidates.remove(&id) {
            self.drop_island(candidate);
        }
        self.finish_effect(id);
        if self.scroll_correction.is_none() {
            self.anchor = None;
        }
        self.settle();
        true
    }

    /// Returns a validated ordered provider slice to a live effect.
    ///
    /// Edge data may apply immediately. Bootstrap/seek data becomes a candidate
    /// requiring hidden measurement and [`Self::commit_candidate`]. Detached
    /// activation data is stored stale or dropped without replacing foreground.
    /// External mutations that arrived after the effect started are replayed
    /// before the disposition is decided.
    pub fn commit_effect_items(
        &mut self,
        id: EffectId,
        items: &[Item],
        exhausted_before: bool,
        exhausted_after: bool,
        target_handle: Handle,
        alignment: Alignment,
    ) -> CommitDisposition {
        let Some(effect) = self.effects.get(&id).copied() else {
            return CommitDisposition::Rejected;
        };
        match effect.kind {
            EffectKind::EdgeFetch => {
                self.apply_edge_fetch(effect, items, exhausted_before, exhausted_after)
            }
            EffectKind::Bootstrap | EffectKind::Seek => {
                let island_id = self.create_island(IslandRole::Candidate);
                if let Some(island) = self.islands.get_mut(&island_id) {
                    island.before = if exhausted_before {
                        EdgeState::Exhausted
                    } else {
                        EdgeState::Open
                    };
                    island.after = if exhausted_after {
                        EdgeState::Exhausted
                    } else {
                        EdgeState::Open
                    };
                    island
                        .sequence
                        .insert_batch(0, items, &mut self.diagnostics);
                    island.resident_start = 0;
                    island.resident_end = island.len();
                }
                self.replay_journal(island_id, effect.journal_cursor);
                if effect.state == EffectState::Detached {
                    if self.main.is_some() {
                        self.store_stale(island_id, effect.stale_direction);
                        self.finish_effect(id);
                        return CommitDisposition::StoredStale;
                    }
                    self.drop_island(island_id);
                    self.finish_effect(id);
                    return CommitDisposition::Dropped;
                }
                if let Some(stored) = self.effects.get_mut(&id) {
                    stored.state = EffectState::AwaitingCommit;
                    stored.target_handle = target_handle;
                    stored.alignment = alignment;
                }
                self.candidates.insert(id, island_id);
                CommitDisposition::Candidate
            }
        }
    }

    /// Atomically activates a measured candidate owned by `effect_id`.
    ///
    /// The previous main becomes stale on the relative side, target alignment is
    /// restored, Resident is recomputed, and stale merge opportunities are tried.
    /// Returns `false` for a late/non-awaiting effect.
    pub fn commit_candidate(&mut self, effect_id: EffectId) -> bool {
        let Some(effect) = self.effects.get(&effect_id).copied() else {
            return false;
        };
        if effect.state != EffectState::AwaitingCommit {
            return false;
        }
        let Some(candidate_id) = self.candidates.remove(&effect_id) else {
            return false;
        };
        if let Some(old_main) = self.main {
            let stale_direction = effect.direction.opposite();
            self.store_stale(old_main, stale_direction);
        }
        if let Some(candidate) = self.islands.get_mut(&candidate_id) {
            candidate.role = IslandRole::Main;
        }
        self.main = Some(candidate_id);
        self.anchor = None;
        self.bump_layout_revision();
        self.finish_effect(effect_id);
        self.try_merge_stale(Direction::Before, false);
        self.try_merge_stale(Direction::After, false);
        // Stale merging may prepend/append rows around the activated target.
        // Restore only after the final main sequence is known; otherwise the
        // correction still points at the candidate-local pre-merge position.
        self.restore_target(effect.target_handle, effect.alignment);
        self.recompute_resident();
        self.settle();
        true
    }

    /// Returns an awaiting effect's candidate island, or [`INVALID_ISLAND`].
    pub fn candidate_id(&self, effect_id: EffectId) -> IslandId {
        self.candidates
            .get(&effect_id)
            .copied()
            .unwrap_or(INVALID_ISLAND)
    }

    /// Returns rows required to hidden-measure one candidate Layout window.
    ///
    /// The slice uses internal scratch storage and is replaced by a later row
    /// query. An invalid/non-awaiting effect returns an empty slice.
    pub fn candidate_rows(&mut self, effect_id: EffectId) -> &[ItemSnapshot] {
        self.layout_rows.clear();
        let Some(effect) = self.effects.get(&effect_id).copied() else {
            return &self.layout_rows;
        };
        let Some(island_id) = self.candidates.get(&effect_id).copied() else {
            return &self.layout_rows;
        };
        let Some(island) = self.islands.get(&island_id) else {
            return &self.layout_rows;
        };
        if island.is_empty() {
            return &self.layout_rows;
        }
        let target = if effect.target_handle != INVALID_HANDLE
            && island.sequence.contains(effect.target_handle)
        {
            effect.target_handle
        } else {
            let index = if effect.alignment == Alignment::End {
                island.len().saturating_sub(1)
            } else {
                0
            };
            island
                .sequence
                .handle_at(index, &mut self.diagnostics)
                .unwrap_or(INVALID_HANDLE)
        };
        let Some(target_row) = island.sequence.item(target, &mut self.diagnostics) else {
            return &self.layout_rows;
        };
        let visible_extent = self.view.visible_extent();
        let visible_start = match effect.alignment {
            Alignment::Start | Alignment::Nearest => target_row.start,
            Alignment::Center => target_row.start + target_row.extent * 0.5 - visible_extent * 0.5,
            Alignment::End => target_row.start + target_row.extent - visible_extent,
        };
        let start = (visible_start - self.view.layout_before)
            .max(0.0)
            .min(island.extent());
        let end = (visible_start + visible_extent + self.view.layout_after)
            .max(start)
            .min(island.extent());
        self.layout_rows = island
            .sequence
            .layout_range(start, end, &mut self.diagnostics);
        &self.layout_rows
    }

    /// Returns current main rows intersecting Layout and Resident, plus all pins.
    ///
    /// The slice uses internal scratch storage and is replaced by a later row query.
    pub fn query_layout(&mut self) -> &[ItemSnapshot] {
        self.layout_rows.clear();
        let Some(main_id) = self.main else {
            return &self.layout_rows;
        };
        let target = self.layout_target();
        let Some(main) = self.islands.get(&main_id) else {
            return &self.layout_rows;
        };
        let start = target.start.max(0.0).min(main.extent());
        let end = target.end.max(start).min(main.extent());
        let mut rows = main
            .sequence
            .layout_range(start, end, &mut self.diagnostics);
        rows.retain(|row| {
            (row.index >= main.resident_start && row.index < main.resident_end)
                || self.pinned.contains(&row.handle)
        });
        for &handle in &self.pinned {
            if rows.iter().any(|row| row.handle == handle) {
                continue;
            }
            if let Some(row) = main.sequence.item(handle, &mut self.diagnostics) {
                rows.push(row);
            }
        }
        rows.sort_by_key(|row| row.index);
        self.layout_rows = rows;
        &self.layout_rows
    }

    /// Returns the non-zero revision of the current desired physical layout.
    pub fn layout_revision(&self) -> u32 {
        self.layout_revision
    }

    /// Acknowledges the exact handles physically committed for `revision`.
    ///
    /// Returns `false` for a stale revision, duplicate-invalid topology, or a
    /// handle absent from main. Duplicate inputs are deduplicated on success.
    pub fn commit_layout(&mut self, revision: u32, handles: &[Handle]) -> bool {
        if revision != self.layout_revision {
            return false;
        }
        let Some(main) = self.main() else {
            self.committed_handles.clear();
            self.committed_revision = revision;
            return handles.is_empty();
        };
        if handles
            .iter()
            .any(|handle| !main.sequence.contains(*handle))
        {
            return false;
        }
        let mut seen = HashSet::new();
        self.committed_handles = handles
            .iter()
            .copied()
            .filter(|handle| seen.insert(*handle))
            .collect();
        self.committed_revision = revision;
        true
    }

    /// Borrows the last successfully acknowledged physical handle set.
    pub fn committed_handles(&self) -> &[Handle] {
        &self.committed_handles
    }

    /// Pins or unpins a main-island row against virtual DOM eviction.
    ///
    /// Returns whether the pin set changed. Pinning an absent handle fails.
    pub fn pin(&mut self, handle: Handle, pinned: bool) -> bool {
        let changed = if pinned {
            if !self
                .main()
                .is_some_and(|main| main.sequence.contains(handle))
            {
                return false;
            }
            self.pinned.insert(handle)
        } else {
            self.pinned.remove(&handle)
        };
        if changed {
            self.bump_layout_revision();
        }
        changed
    }

    /// Captures a semantic scroll-compensation anchor at a VisibleWindow ratio.
    ///
    /// The ratio is clamped to `[0, 1]`. If a correction is already pending, the
    /// existing frame anchor is reused. Returns [`INVALID_HANDLE`] when no row
    /// can cover the waterline.
    pub fn capture_anchor(&mut self, ratio: f64) -> Handle {
        if self.scroll_correction.is_some() {
            if let Some(anchor) = self.anchor {
                return anchor.handle;
            }
        }
        let Some(main_id) = self.main else {
            self.anchor = None;
            return INVALID_HANDLE;
        };
        let visible = self.visible_window();
        let ratio = ratio.clamp(0.0, 1.0);
        let point = visible.start + visible.extent() * ratio;
        let Some(main) = self.islands.get(&main_id) else {
            return INVALID_HANDLE;
        };
        let rows = main.sequence.layout_range(
            point.max(0.0),
            (point + 0.01).max(0.01),
            &mut self.diagnostics,
        );
        let row = rows.into_iter().next().or_else(|| {
            let index = main
                .sequence
                .first_index_intersecting(point, &mut self.diagnostics)?;
            let handle = main.sequence.handle_at(index, &mut self.diagnostics)?;
            main.sequence.item(handle, &mut self.diagnostics)
        });
        let Some(row) = row else {
            self.anchor = None;
            return INVALID_HANDLE;
        };
        self.anchor = Some(Anchor {
            handle: row.handle,
            item_offset: (point - row.start).clamp(0.0, row.extent),
            visible_offset: visible.extent() * ratio,
        });
        row.handle
    }

    /// Batch-applies finite positive physical extents across known islands.
    ///
    /// A shared anchor preserves the visible semantic point. Returns the number
    /// of changed item occurrences, not merely distinct input handles.
    pub fn measure_batch(&mut self, measurements: &[(Handle, f64)]) -> u32 {
        if self.anchor.is_none() {
            self.capture_anchor(0.0);
        }
        let mut changed = 0;
        for island in self.islands.values_mut() {
            for &(handle, extent) in measurements {
                if island
                    .sequence
                    .measure(handle, extent, &mut self.diagnostics)
                {
                    changed += 1;
                }
            }
        }
        if changed > 0 {
            self.bump_layout_revision();
            self.restore_anchor();
            self.settle();
        } else if self.scroll_correction.is_none() {
            self.anchor = None;
        }
        changed
    }

    /// Applies an ordered external insertion adjacent to every known anchor occurrence.
    ///
    /// The mutation is journaled so effects started earlier can replay it. Returns
    /// inserted occurrences across islands/candidates; zero means no known anchor.
    pub fn external_insert(&mut self, anchor: Handle, side: Direction, items: &[Item]) -> u32 {
        if items.is_empty() {
            return 0;
        }
        if self.anchor.is_none() {
            self.capture_anchor(0.0);
        }
        let mutation = JournalMutation::Insert {
            anchor,
            side,
            items: items.to_vec(),
        };
        let changed = self.apply_mutation_all(&mutation);
        self.push_journal(mutation);
        if changed > 0 {
            self.bump_layout_revision();
            self.restore_anchor();
            self.settle();
        } else if self.scroll_correction.is_none() {
            self.anchor = None;
        }
        changed
    }

    /// Applies external deletions across all known state and journals the mutation.
    ///
    /// Deleting the current anchor chooses a local successor/boundary fallback.
    /// Unreferenced handles are queued for release. Returns removed occurrences.
    pub fn external_delete(&mut self, handles: &[Handle]) -> u32 {
        if handles.is_empty() {
            return 0;
        }
        if self.anchor.is_none() {
            self.capture_anchor(0.0);
        }
        let fallback = self.anchor.and_then(|anchor| {
            let main_id = self.main?;
            let main = self.islands.get(&main_id)?;
            if !handles.contains(&anchor.handle) {
                return None;
            }
            main.sequence.rank(anchor.handle, &mut self.diagnostics)
        });
        let mutation = JournalMutation::Delete {
            handles: handles.to_vec(),
        };
        let changed = self.apply_mutation_all(&mutation);
        self.push_journal(mutation);
        for handle in handles {
            self.pinned.remove(handle);
        }
        if let Some(index) = fallback {
            self.replace_deleted_anchor(index);
        }
        self.release_unreferenced(handles.iter().copied());
        if changed > 0 {
            self.bump_layout_revision();
            self.restore_anchor();
            self.settle();
        } else if self.scroll_correction.is_none() {
            self.anchor = None;
        }
        changed
    }

    /// Reopens a main edge and clears its failure latch.
    ///
    /// If removing exhausted geometry changes Blank extent, the current semantic
    /// position is preserved through scroll correction.
    pub fn reopen_edge(&mut self, direction: Direction) {
        if let Some(main_id) = self.main {
            let changes_geometry = self
                .islands
                .get(&main_id)
                .is_some_and(|main| main.edge(direction) != EdgeState::Open);
            if changes_geometry && self.anchor.is_none() {
                self.capture_anchor(0.0);
            }
            self.blocked_edges.remove(&(main_id, direction));
            if let Some(main) = self.islands.get_mut(&main_id) {
                main.set_edge(direction, EdgeState::Open);
            }
            if changes_geometry {
                self.bump_layout_revision();
                self.restore_anchor();
            }
            self.settle();
        }
    }

    /// Clears a failed predictive frontier and schedules it again from the
    /// current physical view. Explicit target seeks do not use this latch.
    pub fn retry_predictive_seek(&mut self, direction: Direction) {
        let Some(main_id) = self.main else {
            return;
        };
        self.blocked_seeks.remove(&(main_id, direction));
        self.settle();
    }

    /// Evicts outer Buffer items until no more than `max_items` remain.
    ///
    /// Trimming never enters Resident or crosses a pinned handle. It is explicit
    /// memory policy, not a provider mutation, and therefore is not journaled.
    /// The trimmed edge becomes open. Returns the number of removed items.
    pub fn trim_buffer(&mut self, direction: Direction, max_items: u32) -> u32 {
        let Some(main_id) = self.main else {
            return 0;
        };
        if self.anchor.is_none() {
            self.capture_anchor(0.0);
        }
        let mut removed = Vec::new();
        if let Some(main) = self.islands.get_mut(&main_id) {
            let available = main.buffer_count(direction);
            let trim = available.saturating_sub(max_items);
            for _ in 0..trim {
                let index = match direction {
                    Direction::Before => 0,
                    Direction::After => main.sequence.len().saturating_sub(1),
                };
                let Some(handle) = main.sequence.handle_at(index, &mut self.diagnostics) else {
                    break;
                };
                if self.pinned.contains(&handle) {
                    break;
                }
                if main
                    .sequence
                    .delete(handle, &mut self.diagnostics)
                    .is_some()
                {
                    removed.push(handle);
                    match direction {
                        Direction::Before => {
                            main.resident_start = main.resident_start.saturating_sub(1);
                            main.resident_end = main.resident_end.saturating_sub(1);
                        }
                        Direction::After => {}
                    }
                }
            }
            if !removed.is_empty() {
                main.set_edge(direction, EdgeState::Open);
            }
        }
        self.release_unreferenced(removed.iter().copied());
        if !removed.is_empty() {
            self.bump_layout_revision();
            self.restore_anchor();
            self.settle();
        } else if self.scroll_correction.is_none() {
            self.anchor = None;
        }
        removed.len().min(u32::MAX as usize) as u32
    }

    /// Consumes the pending absolute surface-local scroll target.
    ///
    /// The physical executor must write this value and then call [`Self::set_view`]
    /// with corrected metrics before normal scheduling continues.
    pub fn take_scroll_correction(&mut self) -> Option<f64> {
        let correction = self.scroll_correction.take();
        if correction.is_some() {
            self.anchor = None;
        }
        correction
    }

    /// Pops a handle no longer referenced by any island or journal entry.
    pub fn pop_released(&mut self) -> Option<Handle> {
        self.released.pop_front()
    }

    /// Returns cumulative saturating sequence work counters.
    pub fn diagnostics(&self) -> Diagnostics {
        self.diagnostics
    }

    fn settle(&mut self) {
        self.recompute_resident();
        // A candidate activation or anchor restoration has produced a physical
        // scroll command. Scheduling against the pre-correction scrollTop would
        // create a spurious predictive seek. The DOM ACKs by applying the
        // correction and sending the next SetView.
        if self.scroll_correction.is_some() {
            return;
        }
        if self.effects.values().any(|effect| {
            matches!(effect.kind, EffectKind::Bootstrap | EffectKind::Seek)
                && effect.target_token != 0
                && effect.state != EffectState::Detached
        }) {
            return;
        }
        match self.blank_zone() {
            BlankZone::Before => self.schedule_seek(Direction::Before),
            BlankZone::After => self.schedule_seek(Direction::After),
            BlankZone::None => self.schedule_edge_fetches(),
        }
    }

    fn recompute_resident(&mut self) {
        let Some(main_id) = self.main else {
            return;
        };
        let target = self.layout_target();
        let Some(main) = self.islands.get_mut(&main_id) else {
            return;
        };
        let len = main.len();
        if len == 0 {
            main.resident_start = 0;
            main.resident_end = 0;
            return;
        }
        let start = target.start.max(0.0).min(main.extent());
        let end = target.end.max(start).min(main.extent());
        let rows = main
            .sequence
            .layout_range(start, end, &mut self.diagnostics);
        let (first, last) = if let (Some(first), Some(last)) = (rows.first(), rows.last()) {
            (first.index, last.index)
        } else {
            let point = (target.start + target.end) * 0.5;
            let index = main
                .sequence
                .first_index_intersecting(point, &mut self.diagnostics)
                .unwrap_or(0);
            (index, index)
        };
        main.resident_start = first.saturating_sub(self.resident_before);
        main.resident_end = last
            .saturating_add(1)
            .saturating_add(self.resident_after)
            .min(len);
    }

    fn schedule_edge_fetches(&mut self) {
        let Some(main_id) = self.main else {
            return;
        };
        let Some(main) = self.islands.get(&main_id) else {
            return;
        };
        if main.is_empty() {
            return;
        }
        let target = self.layout_target();
        let start = target.start.max(0.0).min(main.extent());
        let end = target.end.max(start).min(main.extent());
        let rows = main
            .sequence
            .layout_range(start, end, &mut self.diagnostics);
        let Some(first) = rows.first() else {
            let before = target.end <= 0.0
                && main.buffer_count(Direction::Before) == 0
                && main.before == EdgeState::Open
                && !self.blocked_edges.contains(&(main_id, Direction::Before));
            let after = target.start >= main.extent()
                && main.buffer_count(Direction::After) == 0
                && main.after == EdgeState::Open
                && !self.blocked_edges.contains(&(main_id, Direction::After));
            if before {
                self.schedule_edge(main_id, Direction::Before);
            }
            if after {
                self.schedule_edge(main_id, Direction::After);
            }
            return;
        };
        let last = rows.last().unwrap();
        let need_before = first.index <= self.resident_before;
        let need_after =
            main.len().saturating_sub(last.index.saturating_add(1)) <= self.resident_after;
        let before = need_before
            && main.buffer_count(Direction::Before) == 0
            && main.before == EdgeState::Open
            && !self.blocked_edges.contains(&(main_id, Direction::Before));
        let after = need_after
            && main.buffer_count(Direction::After) == 0
            && main.after == EdgeState::Open
            && !self.blocked_edges.contains(&(main_id, Direction::After));
        if before {
            self.schedule_edge(main_id, Direction::Before);
        }
        if after {
            self.schedule_edge(main_id, Direction::After);
        }
    }

    fn schedule_edge(&mut self, owner: IslandId, direction: Direction) {
        if self.effects.values().any(|effect| {
            effect.kind == EffectKind::EdgeFetch
                && self.resolve_owner(effect.owner) == Some(owner)
                && effect.direction == direction
        }) {
            return;
        }
        self.create_effect(
            EffectKind::EdgeFetch,
            owner,
            direction,
            self.boundary_handle(direction),
            0,
            self.target_extent(),
            0,
        );
    }

    fn schedule_seek(&mut self, direction: Direction) {
        let Some(main_id) = self.main else {
            return;
        };
        if self.blocked_seeks.contains(&(main_id, direction)) {
            return;
        }
        let visible = self.visible_window();
        let point = visible.start + visible.extent() * 0.5;
        let extent = self.main_extent();
        let signed_offset = match direction {
            Direction::Before => (point / self.default_extent).floor() as i64,
            Direction::After => ((point - extent) / self.default_extent).ceil() as i64,
        };
        let threshold = (visible.extent() / self.default_extent).ceil().max(1.0) as i64;
        let existing = self
            .effects
            .values()
            .filter(|effect| {
                effect.kind == EffectKind::Seek
                    && effect.owner == main_id
                    && effect.target_token == 0
                    && effect.state != EffectState::Detached
            })
            .copied()
            .collect::<Vec<_>>();
        if existing.iter().any(|effect| {
            effect.direction == direction
                && (effect.signed_offset - signed_offset).abs() <= threshold
        }) {
            return;
        }
        for effect in existing {
            let stale_direction = if effect.direction == direction {
                direction.opposite()
            } else {
                effect.direction
            };
            if !self.detach_effect_as(effect.id, stale_direction) {
                return;
            }
        }
        self.create_effect(
            EffectKind::Seek,
            main_id,
            direction,
            self.boundary_handle(direction),
            signed_offset,
            self.target_extent(),
            0,
        );
    }

    fn target_extent(&self) -> f64 {
        (self.view.viewport * 2.0).max(self.default_extent)
    }

    fn boundary_handle(&self, direction: Direction) -> Handle {
        let Some(main) = self.main() else {
            return INVALID_HANDLE;
        };
        if main.is_empty() {
            return INVALID_HANDLE;
        }
        let index = match direction {
            Direction::Before => 0,
            Direction::After => main.len() - 1,
        };
        let mut diagnostics = Diagnostics::default();
        main.sequence
            .handle_at(index, &mut diagnostics)
            .unwrap_or(INVALID_HANDLE)
    }

    fn create_effect(
        &mut self,
        kind: EffectKind,
        owner: IslandId,
        direction: Direction,
        anchor: Handle,
        signed_offset: i64,
        target_extent: f64,
        target_token: u32,
    ) -> EffectId {
        let id = self.next_effect.max(1);
        self.next_effect = self.next_effect.wrapping_add(1).max(1);
        let effect = Effect {
            id,
            kind,
            state: EffectState::Pending,
            owner,
            direction,
            anchor,
            signed_offset,
            target_extent,
            target_token,
            target_handle: INVALID_HANDLE,
            alignment: Alignment::Start,
            stale_direction: direction,
            journal_cursor: self.journal_cursor,
        };
        self.effects.insert(id, effect);
        self.effect_outbox.push_back(id);
        id
    }

    fn finish_effect(&mut self, id: EffectId) {
        self.effects.remove(&id);
        self.candidates.remove(&id);
        self.prune_journal();
        self.prune_aliases();
    }

    fn apply_edge_fetch(
        &mut self,
        effect: Effect,
        items: &[Item],
        exhausted_before: bool,
        exhausted_after: bool,
    ) -> CommitDisposition {
        let Some(owner) = self.resolve_owner(effect.owner) else {
            self.finish_effect(effect.id);
            return CommitDisposition::Dropped;
        };
        let owner_role = self.islands.get(&owner).map(|island| island.role);
        let affects_main = Some(owner) == self.main
            || matches!(
                owner_role,
                Some(IslandRole::StaleBefore | IslandRole::StaleAfter)
            );
        if self.anchor.is_none() && affects_main {
            self.capture_anchor(0.0);
        }
        let owner_len_before = self.islands.get(&owner).map_or(0, Island::len);
        let stale_before = self.stale_before;
        let stale_after = self.stale_after;
        let applied = if let Some(island) = self.islands.get_mut(&owner) {
            if !Self::merge_slice(
                &mut island.sequence,
                effect.direction,
                items,
                &mut self.diagnostics,
            ) {
                return CommitDisposition::Rejected;
            }
            if exhausted_before {
                island.before = EdgeState::Exhausted;
            }
            if exhausted_after {
                island.after = EdgeState::Exhausted;
            }
            true
        } else {
            false
        };
        if !applied {
            self.finish_effect(effect.id);
            return CommitDisposition::Dropped;
        }
        self.replay_journal(owner, effect.journal_cursor);
        if Some(owner) == self.main {
            self.try_merge_stale(effect.direction, true);
        } else if owner_role == Some(IslandRole::StaleBefore) {
            self.try_merge_stale(Direction::Before, true);
        } else if owner_role == Some(IslandRole::StaleAfter) {
            self.try_merge_stale(Direction::After, true);
        }
        let owner_grew = self
            .islands
            .get(&owner)
            .is_none_or(|island| island.len() > owner_len_before);
        let topology_changed = self.stale_before != stale_before || self.stale_after != stale_after;
        let exhausted_relevant = match effect.direction {
            Direction::Before => exhausted_before,
            Direction::After => exhausted_after,
        };
        if !owner_grew && !topology_changed && !exhausted_relevant {
            self.blocked_edges.insert((owner, effect.direction));
            if self.scroll_correction.is_none() {
                self.anchor = None;
            }
            return CommitDisposition::Rejected;
        }
        self.blocked_edges.remove(&(owner, effect.direction));
        self.finish_effect(effect.id);
        if affects_main {
            self.bump_layout_revision();
            self.restore_anchor();
            self.settle();
        }
        CommitDisposition::Applied
    }

    fn merge_slice(
        sequence: &mut Sequence,
        direction: Direction,
        items: &[Item],
        diagnostics: &mut Diagnostics,
    ) -> bool {
        let mut previous_rank = None;
        for item in items {
            if let Some(rank) = sequence.rank(item.handle, diagnostics) {
                if previous_rank.is_some_and(|previous| rank <= previous) {
                    return false;
                }
                previous_rank = Some(rank);
            }
        }
        for (position, &item) in items.iter().enumerate() {
            if sequence.contains(item.handle) {
                continue;
            }
            let before_anchor = items[..position]
                .iter()
                .rev()
                .find(|candidate| sequence.contains(candidate.handle))
                .and_then(|candidate| sequence.rank(candidate.handle, diagnostics))
                .map(|rank| rank + 1);
            let after_anchor = items[position + 1..]
                .iter()
                .find(|candidate| sequence.contains(candidate.handle))
                .and_then(|candidate| sequence.rank(candidate.handle, diagnostics));
            let index = before_anchor
                .or(after_anchor)
                .unwrap_or_else(|| match direction {
                    Direction::Before => 0,
                    Direction::After => sequence.len(),
                });
            if !sequence.insert_at(index, item, diagnostics) {
                return false;
            }
        }
        true
    }

    fn try_merge_stale(&mut self, direction: Direction, count_miss: bool) {
        let Some(main_id) = self.main else {
            return;
        };
        let stale_id = match direction {
            Direction::Before => self.stale_before,
            Direction::After => self.stale_after,
        };
        let Some(stale_id) = stale_id else {
            return;
        };
        let (main_rows, stale_rows) = {
            let Some(main) = self.islands.get(&main_id) else {
                return;
            };
            let Some(stale) = self.islands.get(&stale_id) else {
                return;
            };
            (
                main.sequence.snapshots(&mut self.diagnostics),
                stale.sequence.snapshots(&mut self.diagnostics),
            )
        };
        let main_positions = main_rows
            .iter()
            .enumerate()
            .map(|(index, row)| (row.handle, index))
            .collect::<HashMap<_, _>>();
        let common = stale_rows
            .iter()
            .enumerate()
            .filter_map(|(stale_index, row)| {
                main_positions
                    .get(&row.handle)
                    .copied()
                    .map(|main_index| (stale_index, main_index))
            })
            .collect::<Vec<_>>();
        if common.is_empty() {
            if count_miss {
                let should_drop = self.islands.get_mut(&stale_id).is_some_and(|stale| {
                    stale.miss_count = stale.miss_count.saturating_add(1);
                    stale.miss_count >= self.stale_miss_limit
                });
                if should_drop {
                    self.clear_stale_slot(direction);
                    self.drop_island(stale_id);
                }
            }
            return;
        }
        let ordered = common
            .windows(2)
            .all(|pair| pair[0].1 < pair[1].1 && pair[0].0 < pair[1].0);
        if !ordered {
            self.clear_stale_slot(direction);
            self.drop_island(stale_id);
            return;
        }
        let prefix_additions = if common[0].1 == 0 {
            stale_rows[..common[0].0]
                .iter()
                .map(|row| Item {
                    handle: row.handle,
                    extent: row.extent,
                    measured: row.measured,
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let last_common = *common.last().unwrap();
        let suffix_additions = if last_common.1 + 1 == main_rows.len() {
            stale_rows[last_common.0 + 1..]
                .iter()
                .map(|row| Item {
                    handle: row.handle,
                    extent: row.extent,
                    measured: row.measured,
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let gap_additions = common
            .windows(2)
            .filter_map(|pair| {
                let (stale_start, main_start) = pair[0];
                let (stale_end, main_end) = pair[1];
                if main_end != main_start + 1 || stale_end <= stale_start + 1 {
                    return None;
                }
                let anchor = stale_rows[stale_start].handle;
                let items = stale_rows[stale_start + 1..stale_end]
                    .iter()
                    .map(|row| Item {
                        handle: row.handle,
                        extent: row.extent,
                        measured: row.measured,
                    })
                    .collect::<Vec<_>>();
                Some((anchor, items))
            })
            .collect::<Vec<_>>();
        let stale_edge = self
            .islands
            .get(&stale_id)
            .map(|stale| stale.edge(direction))
            .unwrap_or(EdgeState::Open);
        if let Some(main) = self.islands.get_mut(&main_id) {
            Self::merge_slice(
                &mut main.sequence,
                Direction::Before,
                &prefix_additions,
                &mut self.diagnostics,
            );
            for (anchor, items) in gap_additions {
                if let Some(rank) = main.sequence.rank(anchor, &mut self.diagnostics) {
                    main.sequence.insert_batch(
                        rank.saturating_add(1),
                        &items,
                        &mut self.diagnostics,
                    );
                }
            }
            Self::merge_slice(
                &mut main.sequence,
                Direction::After,
                &suffix_additions,
                &mut self.diagnostics,
            );
            main.set_edge(direction, stale_edge);
        }
        self.clear_stale_slot(direction);
        self.aliases.insert(stale_id, main_id);
        self.drop_island(stale_id);
        self.prune_aliases();
        self.bump_layout_revision();
    }

    fn store_stale(&mut self, island_id: IslandId, direction: Direction) {
        let role = match direction {
            Direction::Before => IslandRole::StaleBefore,
            Direction::After => IslandRole::StaleAfter,
        };
        let previous = match direction {
            Direction::Before => self.stale_before.replace(island_id),
            Direction::After => self.stale_after.replace(island_id),
        };
        if let Some(island) = self.islands.get_mut(&island_id) {
            island.role = role;
            island.resident_start = 0;
            island.resident_end = 0;
        }
        if let Some(previous) = previous {
            if previous != island_id && Some(previous) != self.main {
                self.drop_island(previous);
            }
        }
    }

    fn clear_stale_slot(&mut self, direction: Direction) {
        match direction {
            Direction::Before => self.stale_before = None,
            Direction::After => self.stale_after = None,
        }
    }

    fn create_island(&mut self, role: IslandRole) -> IslandId {
        let id = self.next_island.max(1);
        self.next_island = self.next_island.wrapping_add(1).max(1);
        self.islands.insert(id, Island::new(id, role));
        id
    }

    fn drop_island(&mut self, id: IslandId) {
        let Some(island) = self.islands.remove(&id) else {
            return;
        };
        self.blocked_edges.retain(|(owner, _)| *owner != id);
        self.blocked_seeks.retain(|(owner, _)| *owner != id);
        let handles = island
            .sequence
            .snapshots(&mut self.diagnostics)
            .into_iter()
            .map(|row| row.handle)
            .collect::<Vec<_>>();
        self.release_unreferenced(handles);
    }

    fn resolve_owner(&self, mut owner: IslandId) -> Option<IslandId> {
        for _ in 0..16 {
            if self.islands.contains_key(&owner) {
                return Some(owner);
            }
            owner = *self.aliases.get(&owner)?;
        }
        None
    }

    fn prune_aliases(&mut self) {
        let owners = self
            .effects
            .values()
            .map(|effect| effect.owner)
            .collect::<Vec<_>>();
        let mut needed = HashSet::new();
        for mut owner in owners {
            for _ in 0..16 {
                if self.islands.contains_key(&owner) {
                    break;
                }
                let Some(&next) = self.aliases.get(&owner) else {
                    break;
                };
                needed.insert(owner);
                owner = next;
            }
        }
        self.aliases.retain(|owner, _| needed.contains(owner));
    }

    fn apply_mutation_all(&mut self, mutation: &JournalMutation) -> u32 {
        let mut changed = 0;
        for island in self.islands.values_mut() {
            changed += Self::apply_mutation(island, mutation, &mut self.diagnostics);
        }
        changed
    }

    fn apply_mutation(
        island: &mut Island,
        mutation: &JournalMutation,
        diagnostics: &mut Diagnostics,
    ) -> u32 {
        match mutation {
            JournalMutation::Insert {
                anchor,
                side,
                items,
            } => {
                let Some(rank) = island.sequence.rank(*anchor, diagnostics) else {
                    return 0;
                };
                let index = rank + u32::from(*side == Direction::After);
                island
                    .sequence
                    .insert_batch(index, items, diagnostics)
                    .len()
                    .min(u32::MAX as usize) as u32
            }
            JournalMutation::Delete { handles } => handles
                .iter()
                .filter(|handle| island.sequence.delete(**handle, diagnostics).is_some())
                .count()
                .min(u32::MAX as usize) as u32,
        }
    }

    fn push_journal(&mut self, mutation: JournalMutation) {
        self.journal_cursor = self.journal_cursor.saturating_add(1);
        self.journal.push_back(JournalEntry {
            cursor: self.journal_cursor,
            mutation,
        });
        self.prune_journal();
    }

    fn replay_journal(&mut self, island_id: IslandId, cursor: u64) {
        let entries = self
            .journal
            .iter()
            .filter(|entry| entry.cursor > cursor)
            .cloned()
            .collect::<Vec<_>>();
        let Some(island) = self.islands.get_mut(&island_id) else {
            return;
        };
        for entry in entries {
            Self::apply_mutation(island, &entry.mutation, &mut self.diagnostics);
        }
    }

    fn prune_journal(&mut self) {
        let minimum = self
            .effects
            .values()
            .map(|effect| effect.journal_cursor)
            .min()
            .unwrap_or(self.journal_cursor);
        let mut released_candidates = Vec::new();
        while self
            .journal
            .front()
            .is_some_and(|entry| entry.cursor <= minimum)
        {
            if let Some(entry) = self.journal.pop_front() {
                if let JournalMutation::Insert { items, .. } = entry.mutation {
                    released_candidates.extend(items.into_iter().map(|item| item.handle));
                }
            }
        }
        self.release_unreferenced(released_candidates);
    }

    fn restore_target(&mut self, target: Handle, alignment: Alignment) {
        let Some(main) = self.main() else {
            return;
        };
        let target = if target != INVALID_HANDLE && main.sequence.contains(target) {
            target
        } else {
            let index = match alignment {
                Alignment::End => main.len().saturating_sub(1),
                _ => 0,
            };
            let mut diagnostics = Diagnostics::default();
            main.sequence
                .handle_at(index, &mut diagnostics)
                .unwrap_or(INVALID_HANDLE)
        };
        let mut diagnostics = Diagnostics::default();
        let Some(row) = main.sequence.item(target, &mut diagnostics) else {
            return;
        };
        let visible = self.view.visible_extent();
        let local_visible_start = match alignment {
            Alignment::Start | Alignment::Nearest => row.start,
            Alignment::Center => row.start + row.extent * 0.5 - visible * 0.5,
            Alignment::End => row.start + row.extent - visible,
        };
        self.scroll_correction =
            Some(self.island_origin() + local_visible_start - self.view.inset_start);
    }

    fn restore_anchor(&mut self) {
        let Some(anchor) = self.anchor else {
            return;
        };
        let Some(main) = self.main() else {
            return;
        };
        let mut diagnostics = Diagnostics::default();
        let Some(row) = main.sequence.item(anchor.handle, &mut diagnostics) else {
            return;
        };
        let local_visible_start = row.start + anchor.item_offset - anchor.visible_offset;
        self.scroll_correction =
            Some(self.island_origin() + local_visible_start - self.view.inset_start);
    }

    fn replace_deleted_anchor(&mut self, index: u32) {
        let Some(main) = self.main() else {
            self.anchor = None;
            return;
        };
        if main.is_empty() {
            self.anchor = None;
            return;
        }
        let replacement_index = index.min(main.len() - 1);
        let mut diagnostics = Diagnostics::default();
        let Some(handle) = main.sequence.handle_at(replacement_index, &mut diagnostics) else {
            self.anchor = None;
            return;
        };
        if let Some(anchor) = self.anchor.as_mut() {
            anchor.handle = handle;
            anchor.item_offset = 0.0;
        }
    }

    fn committed_window(&self) -> Window {
        let Some(main) = self.main() else {
            return Window::default();
        };
        let mut diagnostics = Diagnostics::default();
        let mut start = f64::INFINITY;
        let mut end = f64::NEG_INFINITY;
        for &handle in &self.committed_handles {
            if let Some(row) = main.sequence.item(handle, &mut diagnostics) {
                start = start.min(row.start);
                end = end.max(row.start + row.extent);
            }
        }
        if start.is_finite() && end.is_finite() {
            Window::new(start, end)
        } else {
            Window::default()
        }
    }

    fn release_unreferenced(&mut self, handles: impl IntoIterator<Item = Handle>) {
        for handle in handles {
            if !self
                .islands
                .values()
                .any(|island| island.sequence.contains(handle))
                && !self.journal.iter().any(|entry| {
                    matches!(
                        &entry.mutation,
                        JournalMutation::Insert { items, .. }
                            if items.iter().any(|item| item.handle == handle)
                    )
                })
                && !self.released.contains(&handle)
            {
                self.released.push_back(handle);
            }
        }
    }

    fn bump_layout_revision(&mut self) {
        self.layout_revision = self.layout_revision.wrapping_add(1).max(1);
    }

    #[cfg(test)]
    /// Asserts internal sequence, Resident, and main-role invariants in tests.
    pub fn validate(&self) {
        for island in self.islands.values() {
            island.sequence.validate();
            assert!(island.resident_start <= island.resident_end);
            assert!(island.resident_end <= island.len());
        }
        if let Some(main) = self.main {
            assert_eq!(self.islands.get(&main).unwrap().role, IslandRole::Main);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(start: u32, count: u32, extent: f64) -> Vec<Item> {
        (start..start + count)
            .map(|handle| Item {
                handle,
                extent,
                measured: false,
            })
            .collect()
    }

    fn ready_engine() -> Engine {
        let mut engine = Engine::new(10.0);
        engine.set_view(ViewMetrics {
            scroll: 200.0,
            viewport: 100.0,
            inset_start: 0.0,
            inset_end: 0.0,
            layout_before: 50.0,
            layout_after: 50.0,
        });
        engine.set_resident_padding(2, 2);
        let effect = engine.begin_bootstrap(0);
        assert_eq!(
            engine.commit_effect_items(
                effect,
                &items(1, 20, 10.0),
                false,
                false,
                1,
                Alignment::Start,
            ),
            CommitDisposition::Candidate
        );
        assert!(engine.commit_candidate(effect));
        let correction = engine.take_scroll_correction().unwrap();
        engine.set_view(ViewMetrics {
            scroll: correction,
            ..engine.view()
        });
        engine
    }

    #[test]
    fn surface_has_twenty_viewports_per_open_edge() {
        let engine = ready_engine();
        assert_eq!(engine.blank_extent(Direction::Before), 2000.0);
        assert_eq!(engine.blank_extent(Direction::After), 2000.0);
        assert_eq!(engine.surface_extent(), 4200.0);
    }

    #[test]
    fn viewport_resize_compensates_the_twenty_viewport_origin() {
        let mut engine = ready_engine();
        engine.set_view(ViewMetrics {
            viewport: 200.0,
            ..engine.view()
        });
        assert_eq!(engine.take_scroll_correction(), Some(4000.0));
    }

    #[test]
    fn resident_is_layout_plus_item_padding() {
        let mut engine = ready_engine();
        let origin = engine.island_origin();
        engine.set_view(ViewMetrics {
            scroll: origin + 50.0,
            ..engine.view()
        });
        let main = engine.main().unwrap();
        assert!(main.resident_start <= 3);
        assert!(main.resident_end >= 17);
        assert_eq!(main.buffer_count(Direction::Before), main.resident_start);
        engine.validate();
    }

    #[test]
    fn relevant_buffer_suppresses_edge_fetch() {
        let mut engine = Engine::new(10.0);
        engine.set_view(ViewMetrics {
            viewport: 100.0,
            ..ViewMetrics::default()
        });
        engine.set_resident_padding(2, 2);
        let bootstrap = engine.begin_bootstrap(0);
        engine.commit_effect_items(
            bootstrap,
            &items(1, 100, 10.0),
            false,
            false,
            1,
            Alignment::Start,
        );
        engine.commit_candidate(bootstrap);
        engine.take_scroll_correction();
        engine.set_view(ViewMetrics {
            scroll: engine.island_origin() + 450.0,
            ..engine.view()
        });
        assert!(engine.buffer_count(Direction::Before) > 0);
        assert!(engine.buffer_count(Direction::After) > 0);
        assert!(!engine
            .effects
            .values()
            .any(|effect| effect.kind == EffectKind::EdgeFetch));
    }

    #[test]
    fn adjacent_blank_is_continuous_before_far_blank_becomes_predictive() {
        let mut engine = ready_engine();
        let origin = engine.island_origin();
        engine.set_view(ViewMetrics {
            scroll: origin + engine.main_extent(),
            layout_before: 0.0,
            layout_after: 0.0,
            ..engine.view()
        });
        assert_eq!(engine.blank_zone(), BlankZone::None);
        assert!(engine.effects.values().any(|effect| {
            effect.kind == EffectKind::EdgeFetch && effect.direction == Direction::After
        }));
        engine.set_view(ViewMetrics {
            scroll: origin + engine.main_extent() + 100.0,
            ..engine.view()
        });
        assert_eq!(engine.blank_zone(), BlankZone::After);
    }

    #[test]
    fn detached_seek_result_becomes_stale() {
        let mut engine = ready_engine();
        let seek = engine.begin_explicit_seek(Direction::After, 7);
        assert!(engine.detach_effect(seek));
        assert_eq!(
            engine.commit_effect_items(
                seek,
                &items(100, 5, 10.0),
                false,
                false,
                100,
                Alignment::Start,
            ),
            CommitDisposition::StoredStale
        );
        assert_ne!(engine.stale_id(Direction::After), INVALID_ISLAND);
    }

    #[test]
    fn candidate_measurement_is_bounded_to_its_layout_window() {
        let mut engine = Engine::new(10.0);
        engine.set_view(ViewMetrics {
            viewport: 100.0,
            layout_before: 50.0,
            layout_after: 50.0,
            ..ViewMetrics::default()
        });
        let effect = engine.begin_bootstrap(0);
        assert_eq!(
            engine.commit_effect_items(
                effect,
                &items(1, 1_000, 10.0),
                false,
                false,
                500,
                Alignment::Center,
            ),
            CommitDisposition::Candidate
        );
        let rows = engine.candidate_rows(effect);
        assert!(rows.len() <= 21, "staged {} candidate rows", rows.len());
        assert!(rows.iter().any(|row| row.handle == 500));
    }

    #[test]
    fn superseded_same_direction_seek_is_stale_before_the_new_landing() {
        let mut engine = ready_engine();
        let old = engine.begin_explicit_seek(Direction::After, 1);
        let new = engine.begin_explicit_seek(Direction::After, 2);
        assert_eq!(engine.effect(old).unwrap().state, EffectState::Detached);
        engine.commit_effect_items(
            new,
            &items(200, 10, 10.0),
            false,
            false,
            200,
            Alignment::Start,
        );
        assert!(engine.commit_candidate(new));
        assert_eq!(
            engine.commit_effect_items(
                old,
                &items(100, 10, 10.0),
                false,
                false,
                100,
                Alignment::Start,
            ),
            CommitDisposition::StoredStale
        );
        assert_ne!(engine.stale_id(Direction::Before), INVALID_ISLAND);
        assert_eq!(engine.stale_id(Direction::After), INVALID_ISLAND);
    }

    #[test]
    fn journal_delete_replays_over_inflight_fetch() {
        let mut engine = ready_engine();
        while engine.pop_effect().is_some() {}
        let owner = engine.main_id();
        let effect = engine.create_effect(
            EffectKind::EdgeFetch,
            owner,
            Direction::After,
            20,
            0,
            100.0,
            0,
        );
        assert_eq!(engine.external_delete(&[22]), 0);
        assert_eq!(
            engine.commit_effect_items(
                effect,
                &items(20, 3, 10.0),
                false,
                false,
                20,
                Alignment::Start,
            ),
            CommitDisposition::Applied
        );
        assert!(!engine.main().unwrap().sequence.contains(22));
    }

    #[test]
    fn old_edge_response_can_extend_stale_and_merge_into_the_new_main() {
        let mut engine = ready_engine();
        let old_main = engine.main_id();
        let edge = engine.create_effect(
            EffectKind::EdgeFetch,
            old_main,
            Direction::After,
            20,
            0,
            100.0,
            0,
        );
        assert!(engine.effect_affects_main(edge));

        let seek = engine.begin_explicit_seek(Direction::After, 1);
        engine.commit_effect_items(
            seek,
            &items(25, 11, 10.0),
            false,
            false,
            25,
            Alignment::Start,
        );
        engine.commit_candidate(seek);
        assert!(!engine.effect_affects_main(edge));
        assert_eq!(
            engine.commit_effect_items(
                edge,
                &items(20, 11, 10.0),
                false,
                false,
                20,
                Alignment::Start,
            ),
            CommitDisposition::Applied
        );
        assert_eq!(engine.main_len(), 35);
        assert_eq!(engine.stale_id(Direction::Before), INVALID_ISLAND);
    }

    #[test]
    fn stale_merge_requires_monotonic_common_order() {
        let mut engine = ready_engine();
        let seek = engine.begin_explicit_seek(Direction::After, 0);
        engine.commit_effect_items(
            seek,
            &[
                Item {
                    handle: 20,
                    extent: 10.0,
                    measured: false,
                },
                Item {
                    handle: 19,
                    extent: 10.0,
                    measured: false,
                },
                Item {
                    handle: 30,
                    extent: 10.0,
                    measured: false,
                },
            ],
            false,
            false,
            20,
            Alignment::Start,
        );
        engine.commit_candidate(seek);
        assert_eq!(engine.stale_id(Direction::Before), INVALID_ISLAND);
    }

    #[test]
    fn stale_before_contributes_only_prefix_while_main_wins_gaps() {
        let mut engine = Engine::new(10.0);
        engine.set_view(ViewMetrics {
            viewport: 100.0,
            ..ViewMetrics::default()
        });
        let bootstrap = engine.begin_bootstrap(0);
        let stale_source = items(1, 9, 10.0);
        engine.commit_effect_items(bootstrap, &stale_source, false, false, 5, Alignment::Start);
        engine.commit_candidate(bootstrap);
        engine.take_scroll_correction();

        let seek = engine.begin_explicit_seek(Direction::After, 1);
        let newest = vec![
            Item {
                handle: 5,
                extent: 10.0,
                measured: false,
            },
            Item {
                handle: 10,
                extent: 10.0,
                measured: false,
            },
            Item {
                handle: 7,
                extent: 10.0,
                measured: false,
            },
            Item {
                handle: 8,
                extent: 10.0,
                measured: false,
            },
            Item {
                handle: 11,
                extent: 10.0,
                measured: false,
            },
        ];
        engine.commit_effect_items(seek, &newest, false, false, 5, Alignment::Start);
        assert!(engine.commit_candidate(seek));
        let main = engine.main_id();
        assert_eq!(
            engine
                .island_rows(main)
                .iter()
                .map(|row| row.handle)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5, 10, 7, 8, 11]
        );
    }

    #[test]
    fn target_alignment_is_restored_after_stale_prefix_merge() {
        let mut engine = ready_engine();
        let seek = engine.begin_explicit_seek(Direction::After, 1);
        assert_eq!(
            engine.commit_effect_items(
                seek,
                &items(15, 11, 10.0),
                false,
                false,
                25,
                Alignment::End,
            ),
            CommitDisposition::Candidate
        );
        assert!(engine.commit_candidate(seek));

        let main = engine.main_id();
        assert_eq!(
            engine
                .island_rows(main)
                .iter()
                .map(|row| row.handle)
                .collect::<Vec<_>>(),
            (1..=25).collect::<Vec<_>>()
        );
        assert_eq!(
            engine.take_scroll_correction(),
            Some(engine.island_origin() + engine.main_extent() - 100.0)
        );
    }

    #[test]
    fn stale_fills_a_gap_only_when_main_has_no_items_between_anchors() {
        let mut engine = Engine::new(10.0);
        engine.set_view(ViewMetrics {
            viewport: 100.0,
            ..ViewMetrics::default()
        });
        let bootstrap = engine.begin_bootstrap(0);
        engine.commit_effect_items(
            bootstrap,
            &items(1, 3, 10.0),
            false,
            false,
            1,
            Alignment::Start,
        );
        engine.commit_candidate(bootstrap);
        engine.take_scroll_correction();

        let seek = engine.begin_explicit_seek(Direction::After, 1);
        engine.commit_effect_items(
            seek,
            &[
                Item {
                    handle: 1,
                    extent: 10.0,
                    measured: false,
                },
                Item {
                    handle: 3,
                    extent: 10.0,
                    measured: false,
                },
                Item {
                    handle: 4,
                    extent: 10.0,
                    measured: false,
                },
            ],
            false,
            false,
            1,
            Alignment::Start,
        );
        engine.commit_candidate(seek);
        let main = engine.main_id();
        assert_eq!(
            engine
                .island_rows(main)
                .iter()
                .map(|row| row.handle)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
    }

    #[test]
    fn stale_island_drops_after_configured_anchor_misses() {
        let mut engine = ready_engine();
        engine.set_stale_miss_limit(2);
        let seek = engine.begin_explicit_seek(Direction::After, 1);
        engine.commit_effect_items(
            seek,
            &items(100, 5, 10.0),
            false,
            false,
            100,
            Alignment::Start,
        );
        assert!(engine.commit_candidate(seek));
        assert_ne!(engine.stale_id(Direction::Before), INVALID_ISLAND);
        engine.try_merge_stale(Direction::Before, true);
        assert_ne!(engine.stale_id(Direction::Before), INVALID_ISLAND);
        engine.try_merge_stale(Direction::Before, true);
        assert_eq!(engine.stale_id(Direction::Before), INVALID_ISLAND);
    }

    #[test]
    fn rejected_edge_is_latched_until_reopened() {
        let mut engine = ready_engine();
        let origin = engine.island_origin();
        engine.set_view(ViewMetrics {
            scroll: origin + 100.0,
            ..engine.view()
        });
        let effect = engine
            .effects
            .values()
            .find(|candidate| {
                candidate.kind == EffectKind::EdgeFetch && candidate.direction == Direction::After
            })
            .unwrap()
            .id;
        assert!(engine.reject_effect(effect));
        engine.settle();
        assert!(!engine.effects.values().any(|candidate| {
            candidate.kind == EffectKind::EdgeFetch && candidate.direction == Direction::After
        }));
        engine.reopen_edge(Direction::After);
        assert!(engine.effects.values().any(|candidate| {
            candidate.kind == EffectKind::EdgeFetch && candidate.direction == Direction::After
        }));
    }

    #[test]
    fn rejected_predictive_seek_is_latched_until_retry() {
        let mut engine = ready_engine();
        let origin = engine.island_origin();
        engine.set_view(ViewMetrics {
            scroll: origin + engine.main_extent() + 200.0,
            ..engine.view()
        });
        let effect = engine
            .effects
            .values()
            .find(|candidate| {
                candidate.kind == EffectKind::Seek
                    && candidate.direction == Direction::After
                    && candidate.target_token == 0
            })
            .unwrap()
            .id;
        assert!(engine.reject_effect(effect));
        engine.set_view(ViewMetrics {
            scroll: origin + engine.main_extent() + 300.0,
            ..engine.view()
        });
        assert!(!engine.effects.values().any(|candidate| {
            candidate.kind == EffectKind::Seek && candidate.direction == Direction::After
        }));
        engine.retry_predictive_seek(Direction::After);
        assert!(engine.effects.values().any(|candidate| {
            candidate.kind == EffectKind::Seek && candidate.direction == Direction::After
        }));
    }
}
