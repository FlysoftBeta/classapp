#!/usr/bin/env node
/** Assemble the target-specific external Node runtime used by a release. */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveBuildCache } from "./build-cache.mjs";
import { resolveBuildTarget } from "./build-targets.mjs";
import { projectRoot } from "../paths.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const root = projectRoot;
const sourceModules = path.join(root, "node_modules");
const runtimePackages = [
  "better-sqlite3",
  "bufferutil",
  "ws",
  "playwright",
  "playwright-core",
  "sharp",
  "detect-libc",
  "@img/colour",
];

function sharpNativePackages(runtimePlatform) {
  if (runtimePlatform === "windows") return ["@img/sharp-win32-x64"];
  return ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"];
}

function packagePath(base, name) {
  return path.join(base, ...name.split("/"));
}

function copyPackage(name, destination) {
  const source = packagePath(sourceModules, name);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing required runtime package: ${name}`);
  }
  const output = packagePath(destination, name);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.cpSync(source, output, { recursive: true });
}

function lockedPackage(lock, name) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry?.version || !entry.integrity) {
    throw new Error(`Missing locked runtime package metadata: ${name}`);
  }
  return {
    version: entry.version,
    integrity: entry.integrity,
    resolved: entry.resolved,
  };
}

function ensurePackage(name, destination, lock) {
  const source = packagePath(sourceModules, name);
  if (fs.existsSync(source)) {
    copyPackage(name, destination);
    return;
  }
  const meta = lockedPackage(lock, name);
  const spec = meta.resolved ?? `${name}@${meta.version}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "classapp-pack-"));
  try {
    execFileSync("npm", ["pack", spec, "--pack-destination", tmp], {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const tarball = fs.readdirSync(tmp).find((file) => file.endsWith(".tgz"));
    if (!tarball) throw new Error(`npm pack produced no tarball for ${name}`);
    const output = packagePath(destination, name);
    fs.mkdirSync(output, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      path.join(tmp, tarball),
      "--strip-components=1",
      "-C",
      output,
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function retainEntries(directory, retained) {
  if (!fs.existsSync(directory)) {
    throw new Error(`Missing native prebuild directory: ${directory}`);
  }
  for (const name of fs.readdirSync(directory)) {
    if (!retained.includes(name)) {
      fs.rmSync(path.join(directory, name), {
        recursive: true,
        force: true,
      });
    }
  }
  for (const name of retained) {
    if (!fs.existsSync(path.join(directory, name))) {
      throw new Error(`Missing required native prebuild: ${name}`);
    }
  }
}

function cacheKey(runtimePlatform, lock) {
  const packages = Object.fromEntries(
    [...runtimePackages, ...sharpNativePackages(runtimePlatform)].map((name) => {
      const meta = lockedPackage(lock, name);
      return [name, { version: meta.version, integrity: meta.integrity }];
    }),
  );
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        runtimePlatform,
        packages,
        assembler: fs.readFileSync(scriptFile, "utf8"),
      }),
    )
    .digest("hex")
    .slice(0, 20);
}

function assemble(destination, runtimePlatform, lock) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of runtimePackages) copyPackage(name, destination);
  for (const name of sharpNativePackages(runtimePlatform)) {
    ensurePackage(name, destination, lock);
  }

  const sqlitePrebuild =
    runtimePlatform === "windows" ? "win32-x64.node" : "linux-x64.node";
  retainEntries(path.join(destination, "better-sqlite3", "prebuilds"), [
    sqlitePrebuild,
  ]);

  const bufferutilPrebuild =
    runtimePlatform === "windows" ? "win32-x64" : "linux-x64";
  retainEntries(path.join(destination, "bufferutil", "prebuilds"), [
    bufferutilPrebuild,
  ]);
}

export function prepareRuntimeDependencies({ targetName, output, cacheRoot }) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Release runtime assembly must run on Linux x64.");
  }
  const { runtimePlatform } = resolveBuildTarget(targetName);
  const destination = path.resolve(root, output);
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  const runtimeCacheRoot =
    cacheRoot ?? path.join(resolveBuildCache(), "native-runtime");
  const cache = path.join(
    runtimeCacheRoot,
    `${runtimePlatform}-${cacheKey(runtimePlatform, lock)}`,
  );

  if (!fs.existsSync(cache)) {
    fs.mkdirSync(runtimeCacheRoot, { recursive: true });
    const staging = fs.mkdtempSync(path.join(runtimeCacheRoot, ".staging-"));
    try {
      assemble(staging, runtimePlatform, lock);
      try {
        fs.renameSync(staging, cache);
      } catch (error) {
        if (!fs.existsSync(cache)) throw error;
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    console.log(`[runtime] cached ${runtimePlatform} native dependencies`);
  } else {
    console.log(`[runtime] native dependency cache hit (${runtimePlatform})`);
  }

  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(cache, destination, { recursive: true });
  console.log(
    `[runtime] assembled ${targetName} dependencies in ${destination}`,
  );
}

function printUsage() {
  console.error("Usage: runtime-deps.mjs <target> <node_modules output>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  const [targetName, output, ...extra] = process.argv.slice(2);
  if (!targetName || !output || extra.length > 0) {
    printUsage();
    process.exitCode = 1;
  } else {
    try {
      prepareRuntimeDependencies({ targetName, output });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
