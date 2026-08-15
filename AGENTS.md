# ClassApp working guide for agents

ClassApp is a React SPA with a custom Node.js/SQLite runtime for a small school
intranet. It runs on Chrome 70–80, including shared or managed devices, and must
remain useful while the server is unavailable. These conditions matter more
than generic Internet-SaaS conventions.

This is a quick orientation and workflow guide. `docs/` is the project's design
memory: it records intent, failure analysis, and current mechanisms, but is not
an infallible specification. Verify it against the code, schemas, and product
premise. When they disagree, investigate and update the relevant explanation
instead of mechanically choosing one side.

Start with [the documentation index](./docs/README.md). Root
`ARCHITECTURE.md` is historical context.

## Project and architecture map

```text
client/      React UI, IndexedDB, offline/sync logic, bundle runtime
server/      Node transport, business domain, SQLite, runtime infrastructure
shared/      wire schemas, types, and pure cross-runtime logic
shell/       stable production loader and Service Worker
launcher/    process, version activation, confirmation, and rollback
scripts/     development, build, operation, and test infrastructure
docs/        engineering design memory and system guides
```

The basic server direction is:

```text
Transport → Action / HTTP adapter → Facade / ActorFacade → Service → Data
```

- Facades select legitimate Actor-dependent business paths.
- Services own coherent objective mechanisms and side effects.
- Data owns SQL and row mapping.
- Runtime owns process-lifetime resources. Scope owns one request and lazily
  composes Actor, Facades, Services, Facts, and UnitOfWork.
- Raw HTTP routes are for operations that genuinely need HTTP semantics such as
  uploads, downloads, ranges, rendering, or discovery.

Read [architecture](./docs/architecture.md) and
[lifetimes](./docs/foundations/lifetimes-and-ownership.md) before changing these
relationships.

The basic client direction is:

```text
component → hook/presentation adapter → client/interact
                                     → client/api and/or client/data
```

- Interact owns local/remote choice, normalization, proposals, coverage,
  reconnect recovery, retention, and quota.
- `client/data` owns IndexedDB representation and atomic primitives.
- Zustand is rebuildable presentation state, not another durable repository.
- Components express intent and render state; they do not own persistence,
  authorization, synchronization, or online/offline policy.

Read the [offline overview](./docs/offline/README.md) and
[frontend state guide](./docs/systems/frontend-state-and-ui.md) before changing
this flow.

Production boot is different from development:

```text
launcher/launcher.js → server.js → bundled server runtime
stable shell.html → active monolithic client bundle in IndexedDB
```

The monolithic bundle is intentional. Shell, HTTPS, ports, WebSocket upgrade,
client activation, version switching, confirmation, and rollback form one
production path.

## Development, scripts, and tests

`npm run dev` builds the browser Wasm prerequisites, then starts the Node
development server on port 3001 and Vite on port 3000. Vite bypasses the
production Shell and bundle-installation path.

```text
npm run lint                 TypeScript and ESLint after prerequisite builds
npm run build -- <target>   Build linux-redhat, linux-debian, or windows
npm run test:e2e            Chrome 70 HTTPS/install/offline/reconnect path
npm run test:manual         Current manual production harness
npm run test:manual-legacy  Legacy-browser manual harness
```

There is no general unit-test runner. Co-located `*.test.ts` files may typecheck
without executing. Use a bounded `.cache` or shell probe for temporary work;
maintained executable scenarios currently belong under `scripts/tests/`.

Infrastructure ownership:

- `scripts/builds/` — prerequisite and release assembly;
- `scripts/dev/` — development orchestration and reset/update tools;
- `scripts/operation/` — narrow operator/build-host workflows;
- `scripts/tests/` — maintained system and manual harnesses;
- `worktree/` — ignored runtime state and secrets;
- `.cache/` — reconstructible intermediates and temporary probes;
- `build/` — final release archives.

See [repository infrastructure](./docs/engineering/repository-infrastructure.md)
and [testing](./docs/engineering/testing.md) for exact behavior.

## Working flow

1. Inspect the working tree and preserve unrelated user changes.
2. Identify the relevant product constraints before importing a familiar
   dependency, abstraction, or “best practice.”
3. Use `docs/README.md` to find the relevant design memory, then trace the real
   producer-to-consumer path in code. Do not infer architecture from one file or
   imitate a pattern merely because it exists.
4. For a nontrivial change, identify the domain fact, owner, lifetime, stable
   identity, transaction/publication boundary, failure windows, and recovery.
   Cross-stack work may require tracing UI, protocol, Facade, Service, Data,
   events, client merge, offline retention, and reconnect repair.
5. Implement through the existing owners. Prefer a coherent migration over two
   representations living indefinitely, while distinguishing irreplaceable
   server data from reconstructible client projections.
6. Update relevant documentation while code and understanding evolve. Do not
   wait until the end or duplicate detailed rules in AGENTS. Correct descriptions
   of mechanisms in the same change; explain changes to design intent.
7. Verify the boundary and failure case actually affected. Review the complete
   diff and report what ran, what did not, and what risk remains.

The fuller design prompts are in
[agent-method.md](./docs/engineering/agent-method.md); they are not a ceremony
required for every small edit.

## Maintaining documentation

- Keep AGENTS as a fast project/workflow guide. Put detailed subsystem reasoning
  in its owning document and link to it instead of copying it here.
- Distinguish product constraints, design intent/invariants, current mechanisms,
  preferences/cautions, and open limitations. Do not turn a preference or one
  current implementation into an unconditional rule.
- Give each detailed idea one home. Extend an existing topic document before
  creating another; add genuinely new documents to `docs/README.md`.
- Document why an ownership boundary, protocol, or unusual mechanism exists and
  which failure it prevents. Avoid mirroring functions and classes that the code
  already describes.
- Update documentation during investigation and implementation. Remove obsolete
  explanations and links as part of a direct migration; leave unresolved
  conflicts explicit rather than writing around them.
- Preserve established project terminology and English documentation style.
  Check relative links and formatting before handoff.

The full writing and maintenance guide is
[documentation.md](./docs/engineering/documentation.md).

## Questions to keep asking

### Code organization

- Which layer owns this fact or consequence? Is the logic merely in the easiest
  caller or an already-large accidental module?
- Does this introduce a second truth, cache, activation pointer, permission
  check, or representation?
- Does a generic helper hide a missing owner? Can context, locks,
  subscriptions, timers, or temporary files outlive their operation?

### Compatibility and deployment

- Does it actually work in Chrome 70–80, including syntax, CSS, Web APIs,
  IndexedDB, workers, Wasm, and transitive dependencies?
- Am I testing Vite while the affected behavior belongs to Shell, HTTPS,
  Service Worker, launcher, packaging, or rollback?
- Does the expected scale justify the complexity, and does packaging still work
  on both Linux and Windows?

### Data models and consistency

- Is this an objective fact, Actor projection, local user decision, or
  reconstructible materialization? What is its stable identity and owner?
- What do its cursor, revision, coverage, generation, or pointer certify? Can it
  be published before the represented data is durable?
- If a mutable value is duplicated, who updates, detects, and repairs every
  copy? Which states truly need one transaction?
- Can stale responses, events, reconnect, Actor switching, or partial writes
  erase newer intent? Can server repair preserve local-only decisions?

### UI organization and design

- Is the UI rendering canonical/interact state and expressing intent, or has it
  acquired business, persistence, authorization, or sync policy?
- Should this state be durable IndexedDB domain state, shared Zustand
  presentation state, or ephemeral component interaction?
- Does the UI distinguish useful stale data, loading, confirmed absence,
  inadequate offline coverage, checked rejection, and unexpected Incident when
  that distinction matters?
- Are stable identity, keyboard/accessibility behavior, bounded rendering,
  narrow screens, and Chinese-content layout preserved?

Concrete guidance on schemas, secrets, materialization, transactions, recovery,
compatibility, and test placement belongs in
[coding standards](./docs/engineering/coding-standards.md),
[server data model](./docs/foundations/server-data-model.md),
[offline consistency](./docs/offline/consistency-and-recovery.md), and
[known traps](./docs/engineering/traps.md).

## Finishing a change

Choose verification proportionally. `npm run lint` is the common type/lint
check; production build, Chrome 70 E2E, migration exercise, or platform testing
is needed when that boundary changed. Vite does not validate production, and
compilation does not execute co-located tests.

Before handoff, state the behavior and failure cases verified, exact commands or
manual checks, anything skipped, migrations/cleanup/documentation handled, and
remaining uncertainty without disguising it as success.
