# AI Agent runtime

The server reads `worktree/secrets/models.json` in development. Production
builds copy the same file to the active deployment as `models.json`, alongside
the HTTPS deployment material. If the file is absent or invalid, the rest of
ClassApp still starts and the AI UI reports that it is unavailable.

Start from `docs/ai-models.example.json`. Prices are integer credits per one
million tokens. A Harness placeholder can list multiple provider models in
fallback order. The Harness retries only transient failures and never switches
models after output has become visible.

The main placeholders are routing, fast chat, reasoning chat, vision, writing,
metadata, search tags, and context compaction. The configuration validator
requires structured-output support for classifier/metadata jobs and function
calling for writing. If no model under `chat_vision` advertises image input,
image requests fail explicitly before credits are reserved. This matters for
DeepSeek V4: its Responses API currently replaces image items with placeholder
text rather than processing the image, so it must be declared text-only.

## DeepSeek V4

The production configuration may use `https://api.deepseek.com` as an OpenAI
provider. As of 2026-08-13, DeepSeek exposes `deepseek-v4-flash` and
`deepseek-v4-pro`; both support Responses API, JSON output, function tools,
reasoning effort, a 1M context window, and up to 384K output. The application
uses lower configurable context/output ceilings to control latency and cost.

DeepSeek pricing is stored directly as credits per million tokens: Flash uses
0.02 cached input / 1 uncached input / 2 output, and Pro uses 0.025 / 3 / 6.
The source of truth is the [DeepSeek pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing).
Unsupported Responses fields such as `store`, `safety_identifier`, and text
verbosity are silently ignored by DeepSeek. Structured auxiliary calls send
`reasoning.effort: none`; routed user requests use the Agent-selected effort.

Each user has one ZIP workspace under the data root. Its `catalog.json` maps
semantic logical paths to opaque ZIP object names. Agent-authored files are
limited to `txt`, `md`, and safe `svg`; image attachments share the same archive.
The uncompressed workspace limit is 10 MiB, and every archive publication uses
a temporary file followed by rename.
