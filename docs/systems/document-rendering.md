# Document rendering and bundle reading

ClassApp does not execute PDF.js in the target browser. PDF compatibility,
memory behavior, and offline use are solved by rendering once on the server into
an immutable renderer-neutral archive, then progressively transferring only the
items and dependencies needed by the reader.

## Pipeline

```text
multipart PDF upload
  → Facade authorizes target Group before render-slot use
  → source stored in unique article artifact directory
  → bundled platform pdfrender process
  → temporary render archive
  → strict archive inspection
  → atomic rename to published archive
  → Article metadata transaction
  → post-commit list events

reader
  → Action fetches manifest/item slices
  → raw HTTP fetches framed stored resources in bounded batches
  → IndexedDB extent generations retain encoded bytes
  → zstd decode + raw-size/SHA-256 verification
  → sanitize/rewrite references
  → sandboxed iframe with restrictive CSP and Blob URLs
  → Infini virtualizes fixed-layout items
```

## Render archive

The `.pdrb` concept is currently a standard ZIP64 archive with STORED entries:

- uncompressed `manifest.json`;
- optional zstd dictionary;
- content-addressed identity or independently zstd-compressed resources;
- renderer-neutral fixed-layout items with dimensions, document resource, and
  dependencies.

Text becomes selectable positioned HTML over SVG/background assets. Images are
WebP. Math/type-3 cases may remain graphical with an accessibility text copy.
The renderer spools per-page work to disk, bounding memory by active work rather
than whole-document output.

Archive inspection must reject unsafe/duplicate paths, unsupported compression,
offsets outside file bounds, inconsistent sizes, duplicate content identities,
invalid manifest relationships, and item ordinal disagreement. `storedOffset`
is verified against the ZIP directory before range streaming.

## Progressive protocol

Items are requested around a cursor (`before`, `after`) so first page does not
download the entire archive. Resource descriptors include:

```text
content_id, MIME, encoding, raw_size, stored_size
```

The raw HTTP resource endpoint accepts at most a bounded unique ID list and
returns a binary frame with magic/version/count followed by content-ID/size and
stored bytes. It computes total size before sending, opens range streams lazily,
and enforces a maximum batch.

Actions carry small manifest/item metadata because they benefit from normal
contracts. HTTP carries large streaming bytes because it needs body streaming
and content length. Both call the same Article Facade authority path.

## Client storage and offline use

Resource logical IDs are derived from Article/content identity and stored in
extent generations. Stored zstd bytes are retained without inflate/recompress.
An offline item is available only when its document, dependencies, shared
resources, and dictionary are complete.

Materialization must prove complete item/resource coverage before marking an
Article saved. Eviction occurs by complete resource/generation and preserves the
retention claim with an `evicted` state when forced.

## Rendering security

Renderer output is untrusted even though it was produced server-side.

- parse as a document, not concatenate arbitrary HTML;
- allow only expected tags/attributes and content-ID references;
- remove external URLs, `srcset`, event handlers, scripts, forms, and active
  content not explicitly part of the trusted frame runtime;
- verify declared MIME against resource descriptor and consuming tag;
- substitute local Blob URLs only after verification;
- render in a sandboxed iframe;
- inject a restrictive CSP: no network, base URI, forms, or arbitrary scripts;
- revoke object URLs with the item/frame lifecycle.

The Blob prohibition applies to IndexedDB persistence, not temporary object
URLs. Blob URLs are the correct adapter for already verified in-memory bytes.

## Process and packaging

Release builds include exactly the target platform's renderer and runtime
dependencies. Linux Debian-family and Red-Hat-family binaries are not
interchangeable; Windows includes required DLLs and keeps launcher/runtime paths
Windows-compatible. Release builds never download renderer artifacts. A
separate authenticated maintenance script refreshes and validates all committed
platform packages atomically.

Render processes have bounded concurrency, timeouts, output checks, and cleanup.
A failed render must remove its unpublished artifact directory without replacing
the original error. DB metadata is not inserted until the archive is valid.

## Rejected shortcuts

- client PDF.js without Chrome 70 and offline proof;
- rasterizing every requested page repeatedly on the server;
- downloading the whole archive for page one;
- persisting IDB Blob values;
- serving extracted renderer HTML directly in the application origin;
- trusting file extensions/MIME claims;
- marking materialized after a loop ends without proving expected coverage;
- deleting source/archive before the database transaction that owns deletion
  commits.
