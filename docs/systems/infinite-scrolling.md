# Infinite scrolling and large readers

Infini is the shared virtualization engine for chat history, Article lists,
long-text chunks, document bundle items, and other large variable-height views.
Its purpose is not just performance: it preserves visual position while data is
inserted, removed, measured, fetched in both directions, or sought far away.

## Separation of concerns

```text
server/client-interact provider
  owns cursor semantics, coverage, fetch/locate and entity merge

Infini core controller
  owns finite window state, operations, replay, demotion and seek

DOM support
  owns measurement, scroll anchor compensation and host coordinates

React adapter / InfiniView
  renders snapshot, directional progress/error and rows
```

Infini does not prove server data completeness. Coverage remains in the offline
domain protocol. A controller window may demote items for memory while the
repository retains a larger proven interval, or the reverse after quota trim.

## Provider contract

Every provider defines:

- stable item ID;
- cursor/order independent of array index;
- bootstrap around a target or root;
- `before` and `after` fetch with exhaustion flags;
- locate/seek semantics and acceptable estimate error;
- duplicate/update/delete arbitration;
- cancellation and stale-operation generation;
- demotion/eviction behavior.

Do not translate a visual offset directly into SQL OFFSET. Article list uses
opaque keyset cursor. Posts use sequence/cursor. A distant seek may locate an
anchor through a dedicated Action or bounded continuous paging.

## Anchor invariants

- Measuring a row may change estimated layout but must preserve the configured
  visual anchor.
- Prepending older items compensates scroll position by inserted measured/
  estimated height.
- Appending live items auto-follows only when the user's viewport policy says
  they were at the live edge.
- A reply/reader seek must not be overwritten by a concurrent bootstrap result.
- DOM row key remains stable across content revision; revision changes content,
  not identity.
- Window demotion does not assert server deletion or coverage loss.

## Operation replay

Live mutations may arrive during bootstrap/fetch/seek. Queue them against the
operation generation and replay in order after the provider result is merged.
If actor/query changes, discard the old operation and its queue. Do not let an
old page replace a newer live row.

Directional failures preserve current items and expose retry at the affected
edge. A bootstrap failure with no items shows central retry. Returning an empty
view for any error destroys both diagnosis and scroll state.

## Text reader chunks

Server storage segments use fixed maximum UTF-16 code-unit size and safe
surrogate boundaries. Client display chunks are a separate presentation layer:
prefer paragraph/newline boundaries, then sentence boundaries, with a hard
maximum for pathological long paragraphs. Offsets remain absolute UTF-16
offsets so progress and seek do not depend on presentation chunking.

Incomplete trailing text is not emitted as a standalone stable chunk until its
boundary is known, except at EOF. Blank-only chunks are suppressed. Do not make
server segment boundaries visible as paragraphs.

## Browser compatibility

Infini's Rust/WASM core is built from the pinned submodule with a fixed nightly,
`build-std`, and WebAssembly MVP target features for Chrome 70. Generated glue
is compatibility-rewritten when necessary. A dependency update requires real
Chrome 70 layout/scroll tests, not only WASM compilation.

Test window and element scroll hosts, variable-height mutation, clamp correction,
seek alignment, append/prepend, React lifecycle, and touch-sized viewports. CSS
flex-gap/min/max fallbacks must not invalidate measurements.

## Common mistakes

- using list index as identity/cursor;
- equating controller window with cache coverage;
- allowing overlapping fetches without generation/replay;
- resetting the whole controller for one row update;
- rendering unbounded header/footer height without informing layout;
- persisting display chunks as canonical Article segments;
- assuming estimated seek is an authoritative server locator;
- testing only fixed-height rows or modern Chromium.
