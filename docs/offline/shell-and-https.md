# Shell, HTTPS, and offline boot

Offline boot is a chain of trust and ownership:

```text
legacy HTTP entry
  → long-lived 301 after administrator enables upgrade
  → HTTPS secure context
  → Service Worker navigation interception
  → selected cached shell.html
  → selected IndexedDB bundle
  → application recovery
```

A change to any link must be evaluated against the entire chain.

## Thin Shell

`shell.html` is deliberately small, old-browser-compatible, and stable. It may:

- install/verify its independent IndexedDB stores;
- register the Service Worker in a secure context;
- read the active bundle pointer and bytes;
- bootstrap-download a bundle when none exists;
- activate bundle row and pointer transactionally;
- load the bytes through a temporary object URL;
- show a bounded boot error.

It must not contain application business logic, React state, domain schema, or
general update policy. Its source uses syntax/APIs supported by the browser
floor without relying on the application bundle's polyfills.

## Two schema owners

Shell and application use disjoint stores and semantic markers in the same
physical database. An IndexedDB versionchange is a mutual-exclusion event. The
winner may be the other owner, so each algorithm is:

```text
open physical head
  → verify my stores + semantic marker
  → if invalid, close and request head + 1
  → install only my owned schema in onupgradeneeded
  → reopen/verify; retry VersionError races
```

Keep an explicit list of application stores that a yanked migration deletes.
Never delete `shell_bundles`/`shell_kv` from application migration.

## Bundle and Shell activation

One release has one build ID shared by server, Shell, client bundle, Service
Worker metadata, and source maps. Post-bootstrap `BundleManager` is the only
owner of update discovery/download.

```text
fetch no-store manifest
  → if same build, repair Shell cache if needed
  → fetch immutable bundle and Shell assets
  → stage bundle row
  → stage Shell cache
  → activate bundle pointer
  → activate Shell pointer
  → compensate both pointers on partial activation failure
  → reload
```

The Service Worker stages/activates the Shell selected by BundleManager. It does
not independently choose later updates. The initial Service Worker install may
fetch the current manifest only to establish the first offline Shell.

An active pointer is the sole truth. Do not add redundant `active` flags to rows.

## HTTPS as an application feature

Service Workers require a secure context (except localhost). Production can
listen on several HTTP and HTTPS ports in one process. The server publishes
same-protocol origins for load-spread resource fetches; it does not mix secure
and insecure content.

Certificates are issued with ACME DNS-01 via DuckDNS because the intranet host
cannot depend on a public HTTP challenge port. The build includes only the
certificate, private key, selected compatibility root, and deployment config;
DuckDNS token and ACME account key remain in ignored secrets storage.

Compatibility validation checks:

- hostname;
- leaf validity interval;
- certificate/private-key match during issuance;
- every chain signature to the selected root;
- a root old enough for managed legacy clients (currently ISRG Root X1 policy);
- expected configured secure ports.

## Permanent redirect

Only the root navigation is upgraded, and only after an administrator confirms
HTTPS. The HTTP response is a cacheable permanent 301 to the configured domain
and primary secure port. This deliberate long cache lifetime lets a previously
used legacy URL continue to reach the secure origin and cached offline entry
when the server is unavailable.

Because this is difficult to reverse in client caches, never enable it
automatically based merely on certificate presence. Domain, DNS, certificate,
secure listener, Shell, Service Worker, and offline boot must be verified first.

## Compatibility rules

- Do not broaden CORS, introduce an independent listener/port, or change a
  Shell, bundle, or update activation pointer as a local fix. First trace the
  complete origin discovery, HTTP/WebSocket mounting, secure upgrade, caching,
  build identity, activation, confirmation, and rollback contract.
- Do not introduce modern syntax into Shell/Service Worker templates without
  direct Chrome 70 execution.
- Service Worker navigation interception excludes API routes.
- Shell and bundle assets are immutable by build identity; manifest and Service
  Worker script are revalidated/no-store as appropriate.
- Development mode bypasses this path and is insufficient evidence.
- The E2E test must cover online install, server stop, offline navigation, server
  restart/recovery, Shell/app schema races, and legacy HTTP redirect.
