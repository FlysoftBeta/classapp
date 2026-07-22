//! Raw WebAssembly ABI. The exported facade is intentionally numeric and owns
//! no browser, network, Promise, cursor or domain-object state.

use crate::engine::{Effect, Engine};
use crate::types::{
    Alignment, CommitDisposition, Diagnostics, Direction, EdgeState, Handle, Item, ItemSnapshot,
    ViewMetrics, WindowKind, INVALID_EFFECT, INVALID_HANDLE, INVALID_ISLAND,
};

const ABI_VERSION: u32 = 6;

pub struct AbiEngine {
    engine: Engine,
    items: Vec<Item>,
    measurements: Vec<(Handle, f64)>,
    handles: Vec<Handle>,
    rows: Vec<ItemSnapshot>,
    current_effect: Option<Effect>,
}

impl AbiEngine {
    fn new(default_extent: f64) -> Self {
        Self {
            engine: Engine::new(default_extent),
            items: Vec::new(),
            measurements: Vec::new(),
            handles: Vec::new(),
            rows: Vec::new(),
            current_effect: None,
        }
    }
}

unsafe fn state<'a>(pointer: *mut AbiEngine) -> Option<&'a mut AbiEngine> {
    pointer.as_mut()
}

fn bool_u32(value: bool) -> u32 {
    u32::from(value)
}

#[no_mangle]
pub extern "C" fn infini2_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn infini2_create(default_extent: f64) -> *mut AbiEngine {
    Box::into_raw(Box::new(AbiEngine::new(default_extent)))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_destroy(pointer: *mut AbiEngine) {
    if !pointer.is_null() {
        drop(Box::from_raw(pointer));
    }
}

#[no_mangle]
pub unsafe extern "C" fn infini2_reset(pointer: *mut AbiEngine) {
    if let Some(state) = state(pointer) {
        state.engine.reset();
        state.items.clear();
        state.measurements.clear();
        state.handles.clear();
        state.rows.clear();
        state.current_effect = None;
    }
}

#[no_mangle]
pub unsafe extern "C" fn infini2_set_view(
    pointer: *mut AbiEngine,
    scroll: f64,
    viewport: f64,
    inset_start: f64,
    inset_end: f64,
    layout_before: f64,
    layout_after: f64,
) {
    if let Some(state) = state(pointer) {
        state.engine.set_view(ViewMetrics {
            scroll,
            viewport,
            inset_start,
            inset_end,
            layout_before,
            layout_after,
        });
    }
}

#[no_mangle]
pub unsafe extern "C" fn infini2_set_resident_padding(
    pointer: *mut AbiEngine,
    before: u32,
    after: u32,
) {
    if let Some(state) = state(pointer) {
        state.engine.set_resident_padding(before, after);
    }
}

#[no_mangle]
pub unsafe extern "C" fn infini2_set_stale_miss_limit(pointer: *mut AbiEngine, value: u32) {
    if let Some(state) = state(pointer) {
        state.engine.set_stale_miss_limit(value);
    }
}

#[no_mangle]
pub unsafe extern "C" fn infini2_surface_extent(pointer: *mut AbiEngine) -> f64 {
    state(pointer).map_or(0.0, |state| state.engine.surface_extent())
}

#[no_mangle]
pub unsafe extern "C" fn infini2_island_origin(pointer: *mut AbiEngine) -> f64 {
    state(pointer).map_or(0.0, |state| state.engine.island_origin())
}

#[no_mangle]
pub unsafe extern "C" fn infini2_blank_extent(pointer: *mut AbiEngine, direction: u32) -> f64 {
    let Some(direction) = Direction::from_u32(direction) else {
        return 0.0;
    };
    state(pointer).map_or(0.0, |state| state.engine.blank_extent(direction))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_blank_zone(pointer: *mut AbiEngine) -> u32 {
    state(pointer).map_or(0, |state| state.engine.blank_zone() as u32)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_window_start(pointer: *mut AbiEngine, kind: u32) -> f64 {
    let Some(kind) = WindowKind::from_u32(kind) else {
        return 0.0;
    };
    state(pointer).map_or(0.0, |state| state.engine.window(kind).start)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_window_end(pointer: *mut AbiEngine, kind: u32) -> f64 {
    let Some(kind) = WindowKind::from_u32(kind) else {
        return 0.0;
    };
    state(pointer).map_or(0.0, |state| state.engine.window(kind).end)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_main_island(pointer: *mut AbiEngine) -> u32 {
    state(pointer).map_or(INVALID_ISLAND, |state| state.engine.main_id())
}

#[no_mangle]
pub unsafe extern "C" fn infini2_stale_island(pointer: *mut AbiEngine, direction: u32) -> u32 {
    let Some(direction) = Direction::from_u32(direction) else {
        return INVALID_ISLAND;
    };
    state(pointer).map_or(INVALID_ISLAND, |state| state.engine.stale_id(direction))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_island_role(pointer: *mut AbiEngine, island: u32) -> u32 {
    state(pointer)
        .and_then(|state| state.engine.island_role(island))
        .map_or(u32::MAX, |role| role as u32)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_island_edge(
    pointer: *mut AbiEngine,
    island: u32,
    direction: u32,
) -> u32 {
    let Some(direction) = Direction::from_u32(direction) else {
        return EdgeState::Open as u32;
    };
    state(pointer)
        .and_then(|state| state.engine.island_edge(island, direction))
        .map_or(EdgeState::Open as u32, |edge| edge as u32)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_main_len(pointer: *mut AbiEngine) -> u32 {
    state(pointer).map_or(0, |state| state.engine.main_len())
}

#[no_mangle]
pub unsafe extern "C" fn infini2_main_extent(pointer: *mut AbiEngine) -> f64 {
    state(pointer).map_or(0.0, |state| state.engine.main_extent())
}

#[no_mangle]
pub unsafe extern "C" fn infini2_resident_start(pointer: *mut AbiEngine) -> u32 {
    state(pointer).map_or(0, |state| state.engine.resident_bounds().0)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_resident_end(pointer: *mut AbiEngine) -> u32 {
    state(pointer).map_or(0, |state| state.engine.resident_bounds().1)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_resident_count(pointer: *mut AbiEngine) -> u32 {
    state(pointer).map_or(0, |state| state.engine.resident_count())
}

#[no_mangle]
pub unsafe extern "C" fn infini2_resident_handle(pointer: *mut AbiEngine, direction: u32) -> u32 {
    let Some(direction) = Direction::from_u32(direction) else {
        return INVALID_HANDLE;
    };
    state(pointer).map_or(INVALID_HANDLE, |state| {
        state.engine.resident_handle(direction)
    })
}

#[no_mangle]
pub unsafe extern "C" fn infini2_buffer_count(pointer: *mut AbiEngine, direction: u32) -> u32 {
    let Some(direction) = Direction::from_u32(direction) else {
        return 0;
    };
    state(pointer).map_or(0, |state| state.engine.buffer_count(direction))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_items_begin(pointer: *mut AbiEngine) {
    if let Some(state) = state(pointer) {
        state.items.clear();
    }
}

#[no_mangle]
pub unsafe extern "C" fn infini2_items_push(
    pointer: *mut AbiEngine,
    handle: u32,
    extent: f64,
    measured: u32,
) -> u32 {
    let Some(state) = state(pointer) else {
        return 0;
    };
    if handle == INVALID_HANDLE {
        return 0;
    }
    state
        .items
        .push(Item::normalized(handle, extent, measured != 0, 1.0));
    1
}

#[no_mangle]
pub unsafe extern "C" fn infini2_handles_begin(pointer: *mut AbiEngine) {
    if let Some(state) = state(pointer) {
        state.handles.clear();
    }
}

#[no_mangle]
pub unsafe extern "C" fn infini2_handles_push(pointer: *mut AbiEngine, handle: u32) -> u32 {
    let Some(state) = state(pointer) else {
        return 0;
    };
    if handle == INVALID_HANDLE {
        return 0;
    }
    state.handles.push(handle);
    1
}

#[no_mangle]
pub unsafe extern "C" fn infini2_measure_begin(pointer: *mut AbiEngine) {
    if let Some(state) = state(pointer) {
        state.measurements.clear();
    }
}

#[no_mangle]
pub unsafe extern "C" fn infini2_measure_push(
    pointer: *mut AbiEngine,
    handle: u32,
    extent: f64,
) -> u32 {
    let Some(state) = state(pointer) else {
        return 0;
    };
    if handle == INVALID_HANDLE || !extent.is_finite() || extent <= 0.0 {
        return 0;
    }
    state.measurements.push((handle, extent));
    1
}

#[no_mangle]
pub unsafe extern "C" fn infini2_measure_commit(pointer: *mut AbiEngine) -> u32 {
    let Some(state) = state(pointer) else {
        return 0;
    };
    state.engine.measure_batch(&state.measurements)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_begin_bootstrap(
    pointer: *mut AbiEngine,
    target_token: u32,
) -> u32 {
    state(pointer).map_or(INVALID_EFFECT, |state| {
        state.engine.begin_bootstrap(target_token)
    })
}

#[no_mangle]
pub unsafe extern "C" fn infini2_begin_seek(
    pointer: *mut AbiEngine,
    direction: u32,
    target_token: u32,
) -> u32 {
    let Some(direction) = Direction::from_u32(direction) else {
        return INVALID_EFFECT;
    };
    state(pointer).map_or(INVALID_EFFECT, |state| {
        state.engine.begin_explicit_seek(direction, target_token)
    })
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_pop(pointer: *mut AbiEngine) -> u32 {
    let Some(state) = state(pointer) else {
        return 0;
    };
    state.current_effect = state.engine.pop_effect();
    bool_u32(state.current_effect.is_some())
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_query(pointer: *mut AbiEngine, effect: u32) -> u32 {
    let Some(state) = state(pointer) else {
        return 0;
    };
    state.current_effect = state.engine.effect(effect);
    bool_u32(state.current_effect.is_some())
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_affects_main(pointer: *mut AbiEngine, effect: u32) -> u32 {
    state(pointer).map_or(0, |state| {
        bool_u32(state.engine.effect_affects_main(effect))
    })
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_id(pointer: *mut AbiEngine) -> u32 {
    state(pointer)
        .and_then(|state| state.current_effect)
        .map_or(INVALID_EFFECT, |effect| effect.id)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_kind(pointer: *mut AbiEngine) -> u32 {
    state(pointer)
        .and_then(|state| state.current_effect)
        .map_or(u32::MAX, |effect| effect.kind as u32)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_state(pointer: *mut AbiEngine) -> u32 {
    state(pointer)
        .and_then(|state| state.current_effect)
        .map_or(u32::MAX, |effect| effect.state as u32)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_owner(pointer: *mut AbiEngine) -> u32 {
    state(pointer)
        .and_then(|state| state.current_effect)
        .map_or(INVALID_ISLAND, |effect| effect.owner)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_direction(pointer: *mut AbiEngine) -> u32 {
    state(pointer)
        .and_then(|state| state.current_effect)
        .map_or(Direction::After as u32, |effect| effect.direction as u32)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_anchor(pointer: *mut AbiEngine) -> u32 {
    state(pointer)
        .and_then(|state| state.current_effect)
        .map_or(INVALID_HANDLE, |effect| effect.anchor)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_signed_offset(pointer: *mut AbiEngine) -> f64 {
    state(pointer)
        .and_then(|state| state.current_effect)
        .map_or(0.0, |effect| effect.signed_offset as f64)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_target_extent(pointer: *mut AbiEngine) -> f64 {
    state(pointer)
        .and_then(|state| state.current_effect)
        .map_or(0.0, |effect| effect.target_extent)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_target_token(pointer: *mut AbiEngine) -> u32 {
    state(pointer)
        .and_then(|state| state.current_effect)
        .map_or(0, |effect| effect.target_token)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_detach(pointer: *mut AbiEngine, effect: u32) -> u32 {
    state(pointer).map_or(0, |state| bool_u32(state.engine.detach_effect(effect)))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_reject(pointer: *mut AbiEngine, effect: u32) -> u32 {
    state(pointer).map_or(0, |state| bool_u32(state.engine.reject_effect(effect)))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_effect_commit_items(
    pointer: *mut AbiEngine,
    effect: u32,
    exhausted_before: u32,
    exhausted_after: u32,
    target_handle: u32,
    alignment: u32,
) -> u32 {
    let Some(alignment) = Alignment::from_u32(alignment) else {
        return CommitDisposition::Rejected as u32;
    };
    state(pointer).map_or(CommitDisposition::Rejected as u32, |state| {
        state.engine.commit_effect_items(
            effect,
            &state.items,
            exhausted_before != 0,
            exhausted_after != 0,
            target_handle,
            alignment,
        ) as u32
    })
}

#[no_mangle]
pub unsafe extern "C" fn infini2_candidate_commit(pointer: *mut AbiEngine, effect: u32) -> u32 {
    state(pointer).map_or(0, |state| bool_u32(state.engine.commit_candidate(effect)))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_candidate_island(pointer: *mut AbiEngine, effect: u32) -> u32 {
    state(pointer).map_or(INVALID_ISLAND, |state| state.engine.candidate_id(effect))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_external_insert(
    pointer: *mut AbiEngine,
    anchor: u32,
    side: u32,
) -> u32 {
    let Some(side) = Direction::from_u32(side) else {
        return 0;
    };
    state(pointer).map_or(0, |state| {
        state.engine.external_insert(anchor, side, &state.items)
    })
}

#[no_mangle]
pub unsafe extern "C" fn infini2_external_delete(pointer: *mut AbiEngine) -> u32 {
    state(pointer).map_or(0, |state| state.engine.external_delete(&state.handles))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_edge_reopen(pointer: *mut AbiEngine, direction: u32) {
    let Some(direction) = Direction::from_u32(direction) else {
        return;
    };
    if let Some(state) = state(pointer) {
        state.engine.reopen_edge(direction);
    }
}

#[no_mangle]
pub unsafe extern "C" fn infini2_seek_retry(pointer: *mut AbiEngine, direction: u32) {
    let Some(direction) = Direction::from_u32(direction) else {
        return;
    };
    if let Some(state) = state(pointer) {
        state.engine.retry_predictive_seek(direction);
    }
}

#[no_mangle]
pub unsafe extern "C" fn infini2_buffer_trim(
    pointer: *mut AbiEngine,
    direction: u32,
    max_items: u32,
) -> u32 {
    let Some(direction) = Direction::from_u32(direction) else {
        return 0;
    };
    state(pointer).map_or(0, |state| state.engine.trim_buffer(direction, max_items))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_anchor_capture(pointer: *mut AbiEngine, ratio: f64) -> u32 {
    state(pointer).map_or(INVALID_HANDLE, |state| state.engine.capture_anchor(ratio))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_scroll_correction(pointer: *mut AbiEngine) -> f64 {
    state(pointer)
        .and_then(|state| state.engine.take_scroll_correction())
        .unwrap_or(f64::NAN)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_pin(pointer: *mut AbiEngine, handle: u32, pinned: u32) -> u32 {
    state(pointer).map_or(0, |state| bool_u32(state.engine.pin(handle, pinned != 0)))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_layout_query(pointer: *mut AbiEngine) -> u32 {
    let Some(state) = state(pointer) else {
        return 0;
    };
    state.rows = state.engine.query_layout().to_vec();
    state.rows.len().min(u32::MAX as usize) as u32
}

#[no_mangle]
pub unsafe extern "C" fn infini2_candidate_query(pointer: *mut AbiEngine, effect: u32) -> u32 {
    let Some(state) = state(pointer) else {
        return 0;
    };
    state.rows = state.engine.candidate_rows(effect).to_vec();
    state.rows.len().min(u32::MAX as usize) as u32
}

#[no_mangle]
pub unsafe extern "C" fn infini2_island_query(pointer: *mut AbiEngine, island: u32) -> u32 {
    let Some(state) = state(pointer) else {
        return 0;
    };
    state.rows = state.engine.island_rows(island).to_vec();
    state.rows.len().min(u32::MAX as usize) as u32
}

fn row(state: &AbiEngine, index: u32) -> Option<ItemSnapshot> {
    state.rows.get(index as usize).copied()
}

#[no_mangle]
pub unsafe extern "C" fn infini2_row_handle(pointer: *mut AbiEngine, row_index: u32) -> u32 {
    state(pointer)
        .and_then(|state| row(state, row_index))
        .map_or(INVALID_HANDLE, |row| row.handle)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_row_index(pointer: *mut AbiEngine, row_index: u32) -> u32 {
    state(pointer)
        .and_then(|state| row(state, row_index))
        .map_or(u32::MAX, |row| row.index)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_row_start(pointer: *mut AbiEngine, row_index: u32) -> f64 {
    state(pointer)
        .and_then(|state| row(state, row_index))
        .map_or(f64::NAN, |row| row.start)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_row_extent(pointer: *mut AbiEngine, row_index: u32) -> f64 {
    state(pointer)
        .and_then(|state| row(state, row_index))
        .map_or(f64::NAN, |row| row.extent)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_row_measured(pointer: *mut AbiEngine, row_index: u32) -> u32 {
    state(pointer)
        .and_then(|state| row(state, row_index))
        .map_or(0, |row| bool_u32(row.measured))
}

#[no_mangle]
pub unsafe extern "C" fn infini2_layout_revision(pointer: *mut AbiEngine) -> u32 {
    state(pointer).map_or(0, |state| state.engine.layout_revision())
}

#[no_mangle]
pub unsafe extern "C" fn infini2_layout_commit(pointer: *mut AbiEngine, revision: u32) -> u32 {
    state(pointer).map_or(0, |state| {
        bool_u32(state.engine.commit_layout(revision, &state.handles))
    })
}

#[no_mangle]
pub unsafe extern "C" fn infini2_committed_count(pointer: *mut AbiEngine) -> u32 {
    state(pointer).map_or(0, |state| {
        state
            .engine
            .committed_handles()
            .len()
            .min(u32::MAX as usize) as u32
    })
}

#[no_mangle]
pub unsafe extern "C" fn infini2_committed_handle(pointer: *mut AbiEngine, index: u32) -> u32 {
    state(pointer)
        .and_then(|state| {
            state
                .engine
                .committed_handles()
                .get(index as usize)
                .copied()
        })
        .unwrap_or(INVALID_HANDLE)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_released_pop(pointer: *mut AbiEngine) -> u32 {
    state(pointer)
        .and_then(|state| state.engine.pop_released())
        .unwrap_or(INVALID_HANDLE)
}

#[no_mangle]
pub unsafe extern "C" fn infini2_diagnostics(pointer: *mut AbiEngine, field: u32) -> u32 {
    let diagnostics =
        state(pointer).map_or(Diagnostics::default(), |state| state.engine.diagnostics());
    match field {
        0 => diagnostics.visited,
        1 => diagnostics.touched,
        2 => diagnostics.emitted,
        _ => 0,
    }
}
