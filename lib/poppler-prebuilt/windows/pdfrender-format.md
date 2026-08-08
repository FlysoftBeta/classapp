# pdfrender bundle format, version 1

`pdfrender input.pdf output.pdrb` produces an HTML text layer over a Cairo SVG background. Options include `--first-page`, `--last-page`, `--resolution`, `--webp-quality`, `--owner-password`, and `--user-password`. The WebP quality defaults to 80 and accepts values from 0 through 100. Every PNG or JPEG emitted by Cairo is always decoded and re-encoded as WebP; there is intentionally no switch to disable this conversion. Ordinary PDF text is omitted from Cairo and reconstructed with positioned HTML spans using sans/serif/monospace plus bold/italic system-font classes. A small shared script measures each selected system-font word after fonts are ready and applies horizontal scaling to fit the original PDF bounding box; this preserves word gaps when replacement font metrics differ. Type 3 glyph programs stay in SVG and are intentionally omitted from the HTML layer.

To scaffold a bundle as a browser-ready web root with Node.js 22.22 or newer:

```sh
node examples/pdfrender-bundle-parser.mjs output.pdrb webroot
```

All integers are unsigned and little endian. Strings are UTF-8 and are not NUL terminated.

The fixed header is:

| Field           |    Type | Meaning                                              |
| --------------- | ------: | ---------------------------------------------------- |
| magic           | 8 bytes | `PDRBNDL\0`                                          |
| version         |     u16 | `1`                                                  |
| flags           |     u16 | bit 0 indicates little endian; currently exactly `1` |
| dictionary size |     u32 | bytes immediately following the header               |
| blob count      |     u32 | number of unique content records                     |
| file count      |     u32 | number of path records                               |
| reserved        |     u32 | zero                                                 |

The shared dictionary is a raw-content zstd dictionary, sampled across every `text/*` blob and capped at 64 KiB. It is followed by `blob count` blob records:

| Field       |     Type | Meaning                                         |
| ----------- | -------: | ----------------------------------------------- |
| id          | 32 bytes | SHA-256 of the uncompressed content             |
| MIME length |      u16 | length of MIME string                           |
| encoding    |       u8 | `0` stored, `1` zstd with the shared dictionary |
| reserved    |       u8 | zero                                            |
| raw size    |      u64 | uncompressed bytes                              |
| stored size |      u64 | payload bytes                                   |
| MIME        |    bytes | MIME string                                     |
| payload     |    bytes | stored or compressed content                    |

Only MIME types beginning with `text/` use encoding 1, at zstd level 8. Every other MIME type uses encoding 0. This intentionally leaves already-compressed images untouched. Blob records are content-addressed and emitted once, regardless of how many paths reference them.

Finally, `file count` path records map web-root names to blobs:

| Field       |     Type | Meaning                            |
| ----------- | -------: | ---------------------------------- |
| path length |      u16 | path bytes                         |
| reserved    |      u16 | zero                               |
| id          | 32 bytes | referenced blob SHA-256            |
| path        |    bytes | safe, relative POSIX web-root path |

HTML and SVG references contain a content id in `src`, `href`, or an SVG-background object's `data` attribute, plus `data-pdfrender-ref` and `data-pdfrender-mime`. SVG backgrounds use `<object type="image/svg+xml">` because browsers intentionally block an SVG loaded through `<img>` from fetching its own external image assets. A post-processor resolves the id to the desired output path. Cairo image data URIs are decoded into separate blob records before the SVG enters the bundle.

The dependency-free Node.js example in `examples/pdfrender-bundle-parser.mjs` validates bounds, paths, compression policy, sizes, and SHA-256 before scaffolding a browser-ready web root.
