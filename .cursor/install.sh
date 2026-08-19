#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for ClassApp.
#
# Prepares everything `npm run dev`, `npm run lint`, and the build/test scripts
# expect: the pinned Git submodules, the Chrome 70 Wasm toolchain (nightly Rust
# with rust-src plus wasm-pack), Node dependencies, and the prebuilt browser
# Wasm packages. Safe to run repeatedly and against a cached/snapshot state.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Pinned Rust toolchain used by scripts/builds/build-wasm.mjs. Keep in sync with
# CLASSAPP_RUST_TOOLCHAIN / the default in that file.
RUST_TOOLCHAIN="${CLASSAPP_RUST_TOOLCHAIN:-nightly-2026-05-10}"

echo "==> Initializing Git submodules (infini, poppler)"
git submodule update --init --recursive

echo "==> Installing Rust toolchain ${RUST_TOOLCHAIN} with rust-src"
rustup toolchain install "${RUST_TOOLCHAIN}" --component rust-src --profile minimal

# wasm-pack ships a prebuilt binary; building it from source needs a newer Cargo
# (edition2024) than the stable toolchain in the base image provides.
if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "==> Installing wasm-pack (prebuilt binary)"
  curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
else
  echo "==> wasm-pack already installed: $(wasm-pack --version)"
fi

echo "==> Installing Node dependencies (npm ci)"
npm ci

# Build the browser Wasm prerequisites once so the first `npm run dev` is fast.
# `predev` rebuilds these too, but cargo/wasm-pack output is cached.
echo "==> Building Chrome 70 Wasm prerequisites (infini, zstd)"
npm run infini:build
npm run zstd:build

# Cache the pinned media artifacts (yt-dlp + POT provider). Release builds
# (`npm run build -- <target>`) resolve these from .cache/media and fail
# without them. Idempotent: re-runs are cache hits.
echo "==> Caching pinned media artifacts (yt-dlp, POT provider)"
npm run media:update

echo "==> ClassApp environment ready"
