# zstd-web

A minimal one-shot browser decompressor backed by
[`ruzstd`](https://crates.io/crates/ruzstd). The generated wasm-pack module
exports `decompress(input: Uint8Array): Uint8Array` and its normal default
initializer.

Build from the ClassApp root:

```sh
npm run zstd:build
```

The build uses the pinned nightly toolchain, rebuilds `std` for the WebAssembly
MVP, disables post-MVP target features, skips wasm-opt, and patches generated
wasm-bindgen memory views for Chrome 70. Set `CLASSAPP_RUST_TOOLCHAIN` to
override the pinned nightly.

The output is generated in `pkg/`. Call and await the default initializer once
before calling `decompress`. The wrapper decodes exactly one Zstandard frame
and allocates the complete decompressed result in memory.
