# Coding standards

## Type and contract discipline

- Keep TypeScript strict; do not solve model transitions with `any`, broad casts,
  or unchecked JSON.
- Use discriminated unions for state machines and command results.
- Validate every external boundary: WebSocket frame, Action args/output, HTTP
  metadata, archive manifest, config/secrets file, AI structured output.
- Convert storage encodings (bitsets, JSON columns, integer booleans) into
  semantic types inside Data.
- Use stable IDs in domain types; mutable handles are display/search values.
- Timestamps must state clock/timezone and ordering purpose. Money/storage sizes
  use safe integers and explicit units in names.

### Schema choice

Use a schema at an untrusted, persisted, or cross-runtime structural boundary
when accepting malformed shape would move the failure away from its owner. Zod
is the existing default for wire contracts, configuration, manifests, and
structured provider output. Reuse the shared registry and domain schemas rather
than introduce a second validation vocabulary casually.

Not every internal object needs a Zod schema. Purely in-process values already
constructed by typed code may be better protected by TypeScript, domain
constructors, database constraints, or assertions. Decide which boundary is
untrusted and which semantic checks remain after structural parsing.

## Module design

- One module has a coherent mechanism and explicit exclusions.
- Group related helpers near their owner; avoid miscellaneous utility dumps.
- Public entry points are few and semantic. Keep raw primitives private.
- Dependency injection/composition makes stateful collaborators visible.
- Avoid new global mutable state and singleton service locators.
- Split a large file when independent mechanisms, lifetimes, or test matrices
  emerge—not merely at an arbitrary line count.

The 1,100-line AI Data module and giant admin components are warnings: do not
add another unrelated branch to them. Extract by ownership while preserving
atomic transaction APIs. Client merge algebras belong in `client/repo`, not in
`client/data/repository.ts`.

## Async and resources

- Capture actor/operation context before the first `await`.
- Every acquired lease/lock/controller/timer/temp file has an adjacent `finally`
  owner.
- Do not await network/timer/decompression inside IDB or SQLite transaction.
- Bound concurrency, queues, response sizes, retries, and memory.
- Use idempotency keys for retryable mutations and durable operations.
- Use generation/pointer publication for multi-step files/assets.
- Preserve primary errors; attach cleanup errors as suppressed diagnostics.

## Database

- SQL lives in `server/data` only. Schema bootstrap/migrations live in the
  database infrastructure, not opportunistically in a domain read function.
- Parameterize values; whitelist any dynamic identifier/order fragment.
- Use constraints/triggers for structural invariants and semantic prechecks for
  public messages.
- Avoid N+1 queries; side-bundle normalized identities or join once.
- Keyset pagination uses stable tie-breakers and matching query-plan evidence.
- Server migrations are ordered, transactional, and advance version in the same
  transaction. No dual write.
- Cross-Service atomicity uses `UnitOfWork`; post-commit effects never originate
  from Data.

## Client data

- Persist `ArrayBuffer`, not Blob.
- IDB transactions complete on `oncomplete`, not request success.
- No network or unrelated await inside IDB transaction callbacks.
- A cache row identifies its actor/objective classification.
- Partial collections carry coverage; do not infer completeness from rows.
- Merge rules live in `client/repo`. Persistence adapters apply them; they do
  not invent a second algebra.
- Remote success should survive reconstructible cache failure.
- Zustand contains only ephemeral/rebuildable presentation state.

## React and UI

- Components express intent and render canonical/interact state.
- Hooks may adapt lifecycle/subscription but do not implement merge, online
  choice, authority, or persistence policy.
- Keep effects cancellable and stale-generation-aware.
- Use stable keys and virtualization for large/infinite datasets.
- Reuse the administration table/action contracts.
- Do not display internal bitsets, raw provider model IDs, secrets, or policy
  implementation as product semantics.
- CSS and DOM APIs require Chrome 70 fallbacks/proof.

## Naming

- Names state semantic role and units: `chargedCreditMicros`, `protectedUntil`,
  `knownRevision`, `credentialEpoch`.
- `Coordinator` is the process composition root. `Runtime` suffix is for
  sticky occupancy (process-bound domain jobs), not for the composition root.
  See [occupancy](../foundations/server-occupancy.md).
- `Facade` is a public business surface, not a pass-through wrapper.
- `Service` is a coherent mechanism, not a lifetime marker.
- `Context` is immutable captured operation identity, not a bag of global tools.
- Avoid `manager`, `helper`, `util`, `data`, and `state` without a specific noun.

## Comments and language

Code comments are English. Comment invariants, failure ordering, compatibility
constraints, and ownership. Product UI text may remain Chinese. Documentation
for agent constraints is English.

Do not use decorative section dividers as a substitute for decomposition. A
short flow comment at an important entry point is useful; hundreds of comments
restating code are not.

## Logging and privacy

- Use Incidents at containment boundaries with bounded semantic context.
- Audit successful administrative mutations with safe summaries.
- Do not log PINs, tokens, full request bodies, AI prompts/files, certificates'
  private keys, or authentication URLs.
- Stable IDs may appear when operationally required; mutable display names are
  not reliable diagnostic identity.

## External services and secrets

- Local secret configuration belongs below ignored `worktree/secrets/`, never
  in source, fixtures, client assets, logs, audit, or Incidents.
- A new integration declares who reads its configuration: build host, packaged
  server, launcher, or application Runtime. Do not copy an entire secrets
  directory because one integration needs one file.
- Validate configuration at its owning boundary and fail with a sanitized,
  actionable diagnostic. Never return provider credentials to the browser.
- If packaging must copy a secret/configuration artifact, extend the explicit
  build allowlist and document optional versus required behavior.
- Tests use isolated fake credentials/provider boundaries and must not print or
  mutate real deployment configuration.

## Dead code and compatibility

Migrate directly and delete obsolete files/fields. Do not keep adapters “in case
something calls them” after repository-wide search proves no supported caller.
Compatibility must name a supported source version, owner, test, and removal
condition.
