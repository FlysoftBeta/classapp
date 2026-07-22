//! Platform-independent geometry, residency, island, and work-scheduling core
//! for Infini2.
//!
//! The crate deliberately owns no domain objects, provider cursors, network
//! futures, DOM nodes, or framework lifecycle. An outer executor maps immutable
//! stable IDs to non-zero [`Handle`] values, supplies estimated/measured extents,
//! executes emitted [`Effect`] tickets, and applies scroll corrections.
//!
//! # Model
//!
//! - [`Engine`] owns one current island and at most one reusable stale island on
//!   each side. Unmerged islands are separated by an unknown gap.
//! - [`ViewMetrics`] defines the unobscured visible viewport and Layout overscan.
//!   Every open edge contributes a fixed twenty-viewport blank runway.
//! - Resident is recomputed from Layout-intersecting items plus configured item
//!   padding. Known items outside Resident are Buffer waterlines; a non-empty
//!   directional Buffer suppresses another request in that direction.
//! - Async work is identified per effect. There is no global provider generation:
//!   a detached late result may still become a stale island.
//! - Geometry-changing mutations preserve a semantic anchor and expose an
//!   absolute scroll target through [`Engine::take_scroll_correction`].
//!
//! # Minimal executor setup
//!
//! ```
//! use infini2_core::{Engine, ViewMetrics};
//!
//! let mut engine = Engine::new(48.0);
//! engine.set_resident_padding(20, 20);
//! engine.set_view(ViewMetrics {
//!     scroll: 0.0,
//!     viewport: 800.0,
//!     inset_start: 64.0,
//!     inset_end: 0.0,
//!     layout_before: 800.0,
//!     layout_after: 800.0,
//! });
//! let effect_id = engine.begin_bootstrap(0);
//! assert_ne!(effect_id, 0);
//! assert!(engine.pop_effect().is_some());
//! ```
//!
//! See the repository `lib/infini2/docs/` directory for the complete provider,
//! candidate measurement, island merge, mutation-journal, and layout-ACK protocol.
#![warn(missing_docs)]

mod abi;
mod engine;
mod sequence;
mod types;

/// Asynchronous work, state machine, and numeric engine types.
pub use engine::{Effect, Engine, Island};
/// Fundamental identifiers, enums, geometry values, items, and diagnostics.
pub use types::*;
