//! Public numeric identifiers, geometry values, and state enums.

use core::fmt;

/// Non-zero stable numeric identity of one provider item.
pub type Handle = u32;
/// Non-zero identity of one known contiguous island.
pub type IslandId = u32;
/// Non-zero identity of one asynchronous work ticket.
pub type EffectId = u32;

/// Sentinel used where no item handle exists.
pub const INVALID_HANDLE: Handle = 0;
/// Sentinel used where no island exists.
pub const INVALID_ISLAND: IslandId = 0;
/// Sentinel used where no effect exists.
pub const INVALID_EFFECT: EffectId = 0;

/// Direction in canonical content order.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Direction {
    /// Toward lower ranks in content order.
    Before = 0,
    /// Toward higher ranks in content order.
    After = 1,
}

impl Direction {
    /// Decodes the stable raw ABI representation, returning `None` for invalid values.
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::Before),
            1 => Some(Self::After),
            _ => None,
        }
    }

    /// Returns the other content-order direction.
    pub fn opposite(self) -> Self {
        match self {
            Self::Before => Self::After,
            Self::After => Self::Before,
        }
    }
}

/// Whether a particular known island edge may have more content.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EdgeState {
    /// More content may exist beyond the edge.
    Open = 0,
    /// The provider proved that no content exists beyond the edge.
    Exhausted = 1,
}

impl EdgeState {
    /// Decodes the stable raw ABI representation, returning `None` when invalid.
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::Open),
            1 => Some(Self::Exhausted),
            _ => None,
        }
    }
}

/// Role of a known contiguous island.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IslandRole {
    /// Current island that drives the visible UI.
    Main = 0,
    /// Reusable old island believed to precede the main island.
    StaleBefore = 1,
    /// Reusable old island believed to follow the main island.
    StaleAfter = 2,
    /// Bootstrap/seek island awaiting hidden measurement and activation.
    Candidate = 3,
}

/// Kind of asynchronous work requested from an outer executor.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectKind {
    /// Create the initial main island.
    Bootstrap = 0,
    /// Extend a known adjacent island frontier.
    EdgeFetch = 1,
    /// Establish a new island at a discontinuous location.
    Seek = 2,
}

/// Lifecycle state of an asynchronous effect ticket.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectState {
    /// The executor has not returned provider data yet.
    Pending = 0,
    /// The activation no longer owns foreground but may still produce stale data.
    Detached = 1,
    /// Provider data is accepted and awaits candidate measurement/commit.
    AwaitingCommit = 2,
}

/// How [`crate::Engine::commit_effect_items`] consumed returned provider data.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitDisposition {
    /// The ticket or returned topology was not acceptable.
    Rejected = 0,
    /// The data immediately extended an existing island.
    Applied = 1,
    /// The data formed a candidate that requires measurement and activation.
    Candidate = 2,
    /// A detached activation result was retained as a stale island.
    StoredStale = 3,
    /// The valid result had no remaining topology value and was discarded.
    Dropped = 4,
}

/// Desired placement of a target row inside the visible viewport.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Alignment {
    /// Align the target's start edge to the visible start.
    Start = 0,
    /// Align the target center to the visible center.
    Center = 1,
    /// Align the target's end edge to the visible end.
    End = 2,
    /// Keep the target visible when possible, otherwise choose the nearest edge.
    Nearest = 3,
}

impl Alignment {
    /// Decodes the stable raw ABI representation, returning `None` when invalid.
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::Start),
            1 => Some(Self::Center),
            2 => Some(Self::End),
            3 => Some(Self::Nearest),
            _ => None,
        }
    }
}

/// Predictive blank region containing the current visible waterline.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlankZone {
    /// The waterline remains within continuous-scroll territory.
    None = 0,
    /// A discontinuous before-side seek is required.
    Before = 1,
    /// A discontinuous after-side seek is required.
    After = 2,
}

/// Selects one extent-based view of the current geometry.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WindowKind {
    /// Unobscured physical viewport in main-island-local coordinates.
    Visible = 0,
    /// Visible range expanded by requested Layout overscan.
    LayoutTarget = 1,
    /// Bounding range of the last physically acknowledged handle set.
    LayoutCommitted = 2,
}

impl WindowKind {
    /// Decodes the stable raw ABI representation, returning `None` when invalid.
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::Visible),
            1 => Some(Self::LayoutTarget),
            2 => Some(Self::LayoutCommitted),
            _ => None,
        }
    }
}

/// Half-open, normalized pixel interval.
#[derive(Clone, Copy, Default, PartialEq)]
pub struct Window {
    /// Inclusive start coordinate in CSS/logical pixels.
    pub start: f64,
    /// Exclusive end coordinate, always greater than or equal to `start`.
    pub end: f64,
}

impl Window {
    /// Creates a finite interval, clamping an invalid or earlier end to `start`.
    pub fn new(start: f64, end: f64) -> Self {
        let start = finite_or(start, 0.0);
        let end = finite_or(end, start).max(start);
        Self { start, end }
    }

    /// Returns the non-negative interval length.
    pub fn extent(self) -> f64 {
        (self.end - self.start).max(0.0)
    }
}

impl fmt::Debug for Window {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Window")
            .field("start", &self.start)
            .field("end", &self.end)
            .finish()
    }
}

/// Host-local physical view and Layout overscan metrics.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewMetrics {
    /// Scroll position relative to the Infini2 surface start.
    pub scroll: f64,
    /// Physical host viewport extent.
    pub viewport: f64,
    /// Start-side fixed-overlay inset removed from Visible.
    pub inset_start: f64,
    /// End-side fixed-overlay inset removed from Visible.
    pub inset_end: f64,
    /// Pixel overscan before Visible when selecting Layout.
    pub layout_before: f64,
    /// Pixel overscan after Visible when selecting Layout.
    pub layout_after: f64,
}

impl Default for ViewMetrics {
    fn default() -> Self {
        Self {
            scroll: 0.0,
            viewport: 0.0,
            inset_start: 0.0,
            inset_end: 0.0,
            layout_before: 0.0,
            layout_after: 0.0,
        }
    }
}

impl ViewMetrics {
    /// Replaces non-finite scroll with zero and clamps all extents to non-negative.
    pub fn normalized(self) -> Self {
        Self {
            scroll: finite_or(self.scroll, 0.0),
            viewport: non_negative(self.viewport),
            inset_start: non_negative(self.inset_start),
            inset_end: non_negative(self.inset_end),
            layout_before: non_negative(self.layout_before),
            layout_after: non_negative(self.layout_after),
        }
    }

    /// Returns `viewport - inset_start - inset_end`, clamped to zero.
    pub fn visible_extent(self) -> f64 {
        (self.viewport - self.inset_start - self.inset_end).max(0.0)
    }
}

/// Numeric item supplied by an outer stable-ID registry.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Item {
    /// Non-zero stable handle. The caller must never reuse a deleted identity.
    pub handle: Handle,
    /// Estimated or measured finite positive block extent.
    pub extent: f64,
    /// Whether `extent` came from a physical measurement.
    pub measured: bool,
}

impl Item {
    /// Creates an item, replacing an invalid extent with `fallback`.
    pub fn normalized(handle: Handle, extent: f64, measured: bool, fallback: f64) -> Self {
        let extent = if extent.is_finite() && extent > 0.0 {
            extent
        } else {
            fallback
        };
        Self {
            handle,
            extent,
            measured,
        }
    }
}

/// Read-only row geometry returned by range and island queries.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ItemSnapshot {
    /// Non-zero stable handle.
    pub handle: Handle,
    /// Zero-based rank inside the source island.
    pub index: u32,
    /// Island-local start coordinate.
    pub start: f64,
    /// Estimated or measured block extent.
    pub extent: f64,
    /// Whether `extent` came from physical measurement.
    pub measured: bool,
}

/// Saturating counters used to verify sequence complexity and query work.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Diagnostics {
    /// Number of sequence nodes inspected by lookups and traversals.
    pub visited: u32,
    /// Number of nodes structurally or geometrically changed.
    pub touched: u32,
    /// Number of rows emitted by range queries.
    pub emitted: u32,
}

impl Diagnostics {
    /// Saturating-increments the visited-node counter.
    pub fn visit(&mut self) {
        self.visited = self.visited.saturating_add(1);
    }

    /// Saturating-increments the changed-node counter.
    pub fn touch(&mut self) {
        self.touched = self.touched.saturating_add(1);
    }

    /// Saturating-increments the emitted-row counter.
    pub fn emit(&mut self) {
        self.emitted = self.emitted.saturating_add(1);
    }
}

/// Returns `value` when finite, otherwise returns `fallback`.
pub fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

/// Returns a finite value clamped to zero or greater.
pub fn non_negative(value: f64) -> f64 {
    finite_or(value, 0.0).max(0.0)
}
