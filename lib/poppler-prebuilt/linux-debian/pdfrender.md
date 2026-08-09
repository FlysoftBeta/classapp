# pdfrender

`pdfrender input.pdf output.zip` renders a PDF into an immutable HTML/SVG
archive. CI publishes separate tar archives for the two supported Linux
distribution families because their system library ABIs are not
interchangeable:

- `pdfrender-linux-debian-x86_64.tar.gz` is built on Ubuntu 24.04.
- `pdfrender-linux-redhat-x86_64.tar.gz` is built on Fedora 44.
- `pdfrender-windows-x86_64.zip` is built with MSYS2 UCRT64 and includes its
  non-system runtime DLLs.

The Linux archives are ordinary tar.gz archives, not DEB or RPM packages.
Extract the archive and invoke its `pdfrender` executable directly. Do not use
the Debian-family binary on a Red Hat-family distribution, or the Red
Hat-family binary on a Debian-family distribution.

## Build dependencies

Debian/Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y \
  cmake ninja-build g++ \
  libcairo2-dev libfontconfig1-dev libfreetype-dev \
  libjpeg-dev libwebp-dev libzstd-dev zlib1g-dev
```

RHEL/Fedora:

```sh
sudo dnf install -y \
  cmake ninja-build gcc-c++ \
  cairo-devel fontconfig-devel freetype-devel \
  libjpeg-turbo-devel libwebp-devel libzstd-devel \
  zlib-ng-compat-devel
```

On RHEL-compatible distributions where classic zlib is still the system
implementation, use `zlib-devel` instead of `zlib-ng-compat-devel`.

```sh
cmake -S . -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DENABLE_CPP=OFF -DENABLE_GLIB=OFF -DENABLE_QT5=OFF -DENABLE_QT6=OFF \
  -DENABLE_BOOST=OFF -DENABLE_LIBOPENJPEG=OFF -DENABLE_LIBJPEG=OFF \
  -DENABLE_LCMS=OFF -DENABLE_LIBCURL=OFF -DENABLE_LIBTIFF=OFF \
  -DENABLE_NSS3=OFF -DENABLE_GPGME=OFF -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_CPP_TESTS=OFF -DBUILD_MANUAL_TESTS=OFF
cmake --build build --target pdfrender
```

## Dependencies

Debian/Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y \
  libcairo2 libfontconfig1 libfreetype6 \
  libjpeg-turbo8 libwebp7 libzstd1 zlib1g \
  libpng16-16t64 libstdc++6 libc6
```

RHEL/Fedora:

```sh
sudo dnf install -y \
  cairo fontconfig freetype \
  libjpeg-turbo libwebp libzstd zlib-ng-compat \
  libpng libstdc++ glibc
```

On RHEL-compatible distributions, use `zlib` instead of `zlib-ng-compat`.

Install suitable system fonts when PDFs may rely on unembedded
or fallback fonts.

## Archive format, version 1

A page is HTML positioned text over a Cairo SVG background; PNG/JPEG assets
are converted to WebP. Ordinary PDF text is excluded from the SVG and
represented as selectable HTML. Type 3 glyph programs remain in SVG.

The container is a standard ZIP64 archive. Every entry uses ZIP method 0
(STORED): binary objects are already compressed formats such as WebP, while
text objects are independently compressed Zstandard frames. Keeping ZIP out
of the object compression layer makes each payload directly range-readable.

### Entries

- `manifest.json`: uncompressed UTF-8 archive index, always present.
- `dictionary.zdict`: optional standard Zstandard dictionary.
- `objects/<sha256>`: identity-encoded binary resource.
- `objects/<sha256>.zst`: Zstandard-compressed text resource.

`<sha256>` is the lowercase SHA-256 of the uncompressed resource. ZIP entry
names are UTF-8. Implementations must reject duplicate, absolute, parent
(`..`) or otherwise unexpected paths.

### Manifest

The manifest has `format: "classapp-render-archive"` and `version: 1`.

- `dictionary` is null or contains `contentId`, `path`, `size`, and
  `storedOffset`.
- `resources[]` contains `contentId`, `mime`, `encoding`, `rawSize`,
  `storedSize`, `storedOffset`, and `path`.
- `files[]` maps semantic archive paths to content IDs.
- `document` describes the renderer-neutral fixed-layout document.

Resource `encoding` is one of `identity`, `zstd`, or `zstd-dictionary`.
`storedOffset` is the absolute byte position of the STORED payload inside the
ZIP file; consumers must validate it against the ZIP directory and file size
before using it for range reads.

The fixed-layout `document` contains `sourceMime`, `shared`, and ordered
`items`. Each item has a stable `id`, zero-based `ordinal`, intrinsic `width`
and `height`, one HTML `document` content ID, and its `dependencies`.

HTML external references use `data-bundle-ref="<contentId>"` alongside a
`src` or `href`. A consumer resolves these references to local files or Blob
URLs. Rendering should occur in a sandboxed iframe with a restrictive CSP.

Text resources use Zstandard level 8. When enough samples exist, pdfrender
trains a standard dictionary capped at 64 KiB and all text frames use it.
Every frame remains independent. Binary resources are identity encoded.

The renderer spools page resources to temporary files as workers finish, so
peak memory is bounded by active pages, dictionary samples, and the largest
single output object instead of total document size.

To validate and scaffold an archive with the example parser:

```sh
node examples/pdfrender-bundle-parser.mjs output.zip webroot
```
