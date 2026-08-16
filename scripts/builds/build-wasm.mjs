import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveBuildCache } from "./build-cache.mjs";

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

const chrome70RustFlags = [
  "-Ctarget-cpu=mvp",
  `-Ctarget-feature=${disabledWasmFeatures.join(",")}`,
];

/**
 * Build wasm-pack output that remains valid WebAssembly MVP and works in
 * Chrome 70. Paths must be absolute so callers can live in different repos.
 */
export function buildChrome70Wasm({
  crateDirectory,
  outputDirectory,
  outputName,
  workingDirectory,
}) {
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });

  // Keep every write below the build cache so prerequisite builds also work in
  // sandboxes that allow workspace writes but mount the user profile read-only.
  // wasm-pack otherwise writes its binary cache to ~/.cache and falls back to
  // `cargo install wasm-bindgen` in ~/.cargo, both of which fail there.
  const wasmPackCache = path.join(resolveBuildCache(), "wasm-pack");
  const cargoHome = path.join(resolveBuildCache(), "cargo-home");
  mkdirSync(wasmPackCache, { recursive: true });
  mkdirSync(cargoHome, { recursive: true });

  const wasmPack = process.platform === "win32" ? "wasm-pack.exe" : "wasm-pack";
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
      outputName,
      // wasm-opt may emit post-MVP instructions even when rustc did not.
      "--no-opt",
      "--",
      "-Z",
      // Precompiled std can also contain post-MVP instructions, so rebuild it
      // under the exact same target-feature restrictions as the crate.
      "build-std=std,panic_abort",
    ],
    {
      cwd: workingDirectory,
      encoding: "utf8",
      stdio: "inherit",
      env: {
        ...process.env,
        CARGO_HOME: cargoHome,
        RUSTUP_TOOLCHAIN:
          process.env.CLASSAPP_RUST_TOOLCHAIN ?? "nightly-2026-05-10",
        RUSTFLAGS: [process.env.RUSTFLAGS, ...chrome70RustFlags]
          .filter(Boolean)
          .join(" "),
        WASM_PACK_CACHE: wasmPackCache,
      },
    },
  );

  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);

  for (const generatedFile of [".gitignore", "package.json", "README.md"]) {
    rmSync(path.join(outputDirectory, generatedFile), { force: true });
  }

  patchDetachedMemoryViews(path.join(outputDirectory, `${outputName}.js`));
}

function patchDetachedMemoryViews(gluePath) {
  const generatedGlue = readFileSync(gluePath, "utf8");
  const viewTypes = ["DataView", "Uint8Array"];
  let compatibleGlue = generatedGlue;
  let patchedViews = 0;

  for (const viewType of viewTypes) {
    const suffix = viewType === "DataView" ? "DataView" : "Uint8Array";
    const cacheName = `cached${suffix}Memory0`;
    const getterName = `get${suffix}Memory0`;
    const getterPattern = new RegExp(
      `let ${cacheName} = null;\\nfunction ${getterName}\\(\\) \\{[\\s\\S]*?\\n\\}`,
    );
    if (!getterPattern.test(compatibleGlue)) continue;

    compatibleGlue = compatibleGlue.replace(
      getterPattern,
      `function ${getterName}() {\n    return new ${viewType}(wasm.memory.buffer);\n}`,
    );
    compatibleGlue = compatibleGlue.replace(
      new RegExp(`    ${cacheName} = null;\\n`, "g"),
      "",
    );
    patchedViews += 1;
  }

  // Bindings without byte slices legitimately have no cached views. If a
  // cache is generated, however, refusing a partial patch is safer than
  // silently shipping glue that breaks after memory.grow on old Chrome.
  if (/cached(?:DataView|Uint8Array)Memory0/.test(compatibleGlue)) {
    throw new Error(
      `Could not patch all wasm-bindgen memory views in ${gluePath}`,
    );
  }
  if (patchedViews > 0) {
    writeFileSync(gluePath, compatibleGlue);
  }
}
