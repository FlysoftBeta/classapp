import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const infiniDirectory = path.join(projectDirectory, "lib", "infini");
const crateDirectory = path.join("crates", "infini-wasm");
const outputDirectory = path.join(
  "..",
  "..",
  "packages",
  "infini-core",
  "src",
  "runtime",
  "wasm",
);
const wasmPack = process.platform === "win32" ? "wasm-pack.exe" : "wasm-pack";

if (!existsSync(path.join(infiniDirectory, "Cargo.toml"))) {
  throw new Error(
    "Infini submodule is missing; run: git submodule update --init --recursive",
  );
}

// Chrome 70 implements the WebAssembly MVP, but not later extensions such as
// non-trapping float-to-int conversion. Rebuilding std is essential: applying
// these flags only to Infini leaves post-MVP instructions in precompiled std.
const disabledWasmFeatures = [
  "bulk-memory",
  "multivalue",
  "mutable-globals",
  "nontrapping-fptoint",
  "reference-types",
  "relaxed-simd",
  "sign-ext",
  "simd128",
  "tail-call",
].map((feature) => `-${feature}`);
const compatibilityFlags = [
  "-Ctarget-cpu=mvp",
  `-Ctarget-feature=${disabledWasmFeatures.join(",")}`,
];

const build = spawnSync(
  wasmPack,
  [
    "build",
    crateDirectory,
    "--target",
    "web",
    "--release",
    "--out-dir",
    outputDirectory,
    "--out-name",
    "infini_wasm",
    "--no-opt",
    "--",
    "-Z",
    "build-std=std,panic_abort",
  ],
  {
    cwd: infiniDirectory,
    encoding: "utf8",
    stdio: "inherit",
    env: {
      ...process.env,
      RUSTUP_TOOLCHAIN:
        process.env.CLASSAPP_RUST_TOOLCHAIN ?? "nightly-2026-05-10",
      RUSTFLAGS: [process.env.RUSTFLAGS, ...compatibilityFlags]
        .filter(Boolean)
        .join(" "),
    },
  },
);

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const generatedDirectory = path.resolve(
  infiniDirectory,
  crateDirectory,
  outputDirectory,
);
for (const generatedFile of [".gitignore", "package.json", "README.md"]) {
  rmSync(path.join(generatedDirectory, generatedFile), { force: true });
}

// wasm-bindgen caches views over WebAssembly.Memory. Chrome 70 detaches those
// views when memory grows, but its old ArrayBuffer behavior is not reliably
// detected by current glue. Always taking a fresh view is slightly less clever
// and fully correct across both synchronous Wasm callbacks and returned calls.
const gluePath = path.join(generatedDirectory, "infini_wasm.js");
const generatedGlue = readFileSync(gluePath, "utf8");
const dataViewPattern =
  /let cachedDataViewMemory0 = null;\nfunction getDataViewMemory0\(\) \{[\s\S]*?\n\}/;
const uint8ViewPattern =
  /let cachedUint8ArrayMemory0 = null;\nfunction getUint8ArrayMemory0\(\) \{[\s\S]*?\n\}/;
const resetViewsPattern =
  /    cachedDataViewMemory0 = null;\n    cachedUint8ArrayMemory0 = null;\n/;
const compatibleGlue = generatedGlue
  .replace(
    dataViewPattern,
    `function getDataViewMemory0() {
    return new DataView(wasm.memory.buffer);
}`,
  )
  .replace(
    uint8ViewPattern,
    `function getUint8ArrayMemory0() {
    return new Uint8Array(wasm.memory.buffer);
}`,
  )
  .replace(resetViewsPattern, "");

if (
  compatibleGlue === generatedGlue ||
  compatibleGlue.includes("cachedDataViewMemory0") ||
  compatibleGlue.includes("cachedUint8ArrayMemory0")
) {
  throw new Error("Could not apply the Chrome 70 wasm-bindgen memory-view fix");
}
writeFileSync(gluePath, compatibleGlue);
