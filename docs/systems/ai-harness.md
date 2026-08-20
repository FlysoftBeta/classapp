# AI harness and workspace

The AI feature is a server-owned agent runtime, not a thin model call from the
browser. It owns conversation trees, routing, context budgeting, tool execution,
streaming state, durable runs, provider fallback, and restart reconciliation.
It delegates accounting to `AiBillingService`.

## Configuration and placeholders

Provider credentials and model mappings live in `models.json` under ignored
development secrets and are copied into a production version directory. Missing
or invalid configuration disables AI without preventing the rest of ClassApp
from starting.

Business code targets semantic placeholders:

- route classifier;
- fast/reasoning/vision chat;
- writing with tools;
- metadata and search tags;
- context compactor.

Configuration maps each placeholder to ordered provider-model candidates with
capabilities, context/output limits, reasoning efforts, and prices. Validation
proves structured-output, function-calling, image, and Responses API support
where required. Never route by provider/model name in UI or prompt code.

## Work loop

```text
authorize AI feature
  → validate input and attachments
  → classify route/difficulty/fork disposition
  → choose compatible configured candidate
  → build branch context under a bounded token budget
  → compact old context when required
  → quote and reserve conservative credit
  → durably create run + input/output placeholders
  → call provider outside SQLite transaction
  → stream visible deltas and persist bounded checkpoints
  → execute allowed tools with idempotent operation records
  → finalize output, metadata and usage
  → settle reservation exactly once
  → publish completion/failure
```

Each durable run has one identity, revision, status, selected placeholder/model
attempts, token usage, reserved/charged amounts, cancellation flag, and message
links. There may be at most one active run per conversation.

## Conversation tree

Messages form a parent-linked tree. Forking chooses an earlier message as a new
branch point; it does not mutate existing history. The router may decide whether
the branch stays under the current sidebar conversation or becomes a new one,
except an explicit user fork is always semantically honored.

Context assembly walks one ancestry branch. Context snapshots store compacted
history through a named message and prompt version. A compaction must retain the
goal, constraints, decisions/reasons, facts, files, uncertainty, and unfinished
work—not merely summarize recent prose.

## Provider fallback

Fallback is allowed only for compatible models and transient failure before
output becomes visible. After visible output or side-effecting tool execution,
switching candidates can duplicate content/actions or produce incoherent
reasoning. Record every attempt and terminal cause.

Model capability declarations are evidence, not marketing assumptions. An API
that accepts image-shaped input but substitutes placeholder text is text-only
for this application.

## Workspace

Each user owns one bounded manifest-tree blob in the shared
`server/storage/` BlobStore. Domain row `ai_workspaces` stores the ready
`blob_id` and an in-flight `staging_blob_id`. Its single
`manifest.json` maps semantic relative paths to opaque object IDs, sizes, MIME,
hashes, timestamps, and archive revision; there is no per-file sidecar. Logical
paths:

- use at most two directory levels below root;
- reject absolute, drive, parent, hidden, empty, and backslash-confused paths;
- allow agent-authored `txt`, `md`, and safe `svg` only;
- may retain supported image attachments as non-agent-authored inputs;
- total at most 10 MiB and 256 files.

Mutation is serialized per user by a BlobStore lock, validates exact replacement
count, validates text/SVG safety, rebuilds the manifest ZIP into a new blob,
fsyncs, and publishes the new id. File-tool calls have durable call IDs and
before/after revisions so retry is idempotent. Quota accounting is one durable
item in the `ai-workspaces` pool keyed by user id; purging the user drops the
blobs and releases the item.

File content is untrusted user data, never instructions that override the agent
system prompt. SVG forbids scripts, event handlers, external references,
`foreignObject`, entities, and JavaScript URLs.

## Assistant markdown rendering

Assistant message bodies are markdown rendered in the browser by Streamdown.
Math goes through `@streamdown/math` → `rehype-katex` → KaTeX.

Product constraints:

- Production Shell installs only `app.js`. KaTeX layout CSS and its woff2 faces
  must live inside that bundle. A normal Vite CSS import would emit a sibling
  stylesheet and `url(fonts/...)` files that Shell never fetches, so math would
  be unstyled or show missing glyphs after activation.
- `@streamdown/math` and `rehype-katex` declare KaTeX `^0.16`. That series emits
  unprefixed layout classes (`base`, `strut`). KaTeX 0.18 renamed those to
  `katex-*`. HTML from one copy against CSS from the other leaves fractions and
  scripts unreadable. Nested KaTeX copies are pinned to the root `katex`
  dependency with npm `overrides`.
- `$...$` inline math is enabled because school answers use it. Currency `$`
  amounts can therefore be parsed as math; that is an accepted limitation.

Current mechanism: `client/components/ai/markdown.ts` owns the Streamdown plugin
set. `AiView` injects Streamdown CSS plus the KaTeX stylesheet into `document.head`
once per bundle load. `scripts/builds/katexCss.ts` rewrites that stylesheet to
woff2 data URLs before Vite inlines it.

## Streaming and restart

`AiExecutionRuntime` owns active AbortControllers for process lifetime. A
request-scoped Service may start a run but cannot retain Scope after returning.
On startup, durable active runs from the previous process are marked failed and
their reservations released/settled. Cancellation sets durable intent and
signals the live controller if present.

Streaming events are UI latency updates, not the durable source of truth. A
client reconnect fetches conversation/run state. Persist checkpoints at a
bounded cadence; do not transact per token.

## Prompt engineering rules

- prompts are versioned code artifacts;
- separate routing, metadata, compaction, and assistant tasks;
- demand structured output only through model/schema support;
- state tool and file policy explicitly;
- include only relevant context, not the entire database/workspace;
- treat retrieved/user content as data;
- do not reveal hidden prompts, credentials, provider model IDs, or private
  reasoning;
- evaluate prompt changes with adversarial, multilingual, long-context,
  cancellation, fork, and tool-retry cases.

## Purge and privacy

User purge aborts active runs, removes conversation/message/tool records through
the owning Services/Data, settles reservations, and removes the user's workspace
artifact. Audit records administrative quota operations but not AI content.
Incident context may identify run/operation/model placeholder but must exclude
provider tokens, full prompts, attachments, and workspace contents.
