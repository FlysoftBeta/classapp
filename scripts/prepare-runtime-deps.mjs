#!/usr/bin/env node
/**
 * Creates the self-contained production runtime used by both Linux x64 and
 * Windows x64 deployments. This runs only while producing a release; the
 * deployed application never invokes npm or downloads a native addon.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2];

if (!output)
  throw new Error("usage: prepare-runtime-deps.mjs <node_modules output>");
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("Release runtime assembly must run on Linux x64.");
}

const sourceModules = path.join(root, "node_modules");
const destination = path.resolve(root, output);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "classapp-runtime-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
}

function packagePath(name, base = sourceModules) {
  return path.join(base, ...name.split("/"));
}

function readPackage(name) {
  return JSON.parse(
    fs.readFileSync(path.join(packagePath(name), "package.json"), "utf8"),
  );
}

function copyPackage(name, from = sourceModules) {
  const src = packagePath(name, from);
  if (!fs.existsSync(src))
    throw new Error(`Missing required runtime package: ${name}`);
  fs.mkdirSync(path.dirname(packagePath(name, destination)), {
    recursive: true,
  });
  fs.cpSync(src, packagePath(name, destination), { recursive: true });
}

function verifyIntegrity(file, integrity) {
  const [algorithm, expected] = integrity.split("-", 2);
  const actual = crypto
    .createHash(algorithm)
    .update(fs.readFileSync(file))
    .digest("base64");
  if (actual !== expected)
    throw new Error(`Integrity check failed for ${path.basename(file)}`);
}

const lock = JSON.parse(
  fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
);

function fetchAndCopyPackage(name, version) {
  const packageTemp = path.join(temp, name.replaceAll("/", "__"));
  fs.mkdirSync(packageTemp, { recursive: true });
  run(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      packageTemp,
      `${name}@${version}`,
    ],
    { cwd: root },
  );
  const archive = fs
    .readdirSync(packageTemp)
    .find((entry) => entry.endsWith(".tgz"));
  if (!archive) throw new Error(`npm pack did not produce ${name}`);

  const integrity = lock.packages?.[`node_modules/${name}`]?.integrity;
  if (!integrity) throw new Error(`Missing lockfile integrity for ${name}`);
  const archivePath = path.join(packageTemp, archive);
  verifyIntegrity(archivePath, integrity);
  run("tar", ["-xzf", archivePath, "-C", packageTemp]);
  fs.mkdirSync(path.dirname(packagePath(name, destination)), {
    recursive: true,
  });
  fs.cpSync(path.join(packageTemp, "package"), packagePath(name, destination), {
    recursive: true,
  });
}

try {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  // better-sqlite3 13 ships N-API prebuilds inside its package. Retain only
  // the Linux x64 (glibc) and Windows x64 variants we support.
  copyPackage("better-sqlite3");
  const sqlitePrebuilds = path.join(destination, "better-sqlite3", "prebuilds");
  for (const name of fs.readdirSync(sqlitePrebuilds)) {
    if (
      !["linux-x64.node", "win32-x64.node"].includes(name)
    ) {
      fs.rmSync(path.join(sqlitePrebuilds, name));
    }
  }

  copyPackage("@napi-rs/canvas");

  // ws resolves this optional native peer at runtime. bufferutil itself ships
  // N-API prebuilds for both target platforms, so no target-side install or
  // compilation is needed.
  copyPackage("ws");
  copyPackage("bufferutil");

  // Playwright contains CommonJS modules that rely on __dirname, so it stays
  // external to the server's ESM bundle. Its runtime package and core package
  // must therefore travel with each deployment.
  copyPackage("playwright");
  copyPackage("playwright-core");

  const canvas = readPackage("@napi-rs/canvas");
  for (const target of [
    "@napi-rs/canvas-linux-x64-gnu",
    "@napi-rs/canvas-win32-x64-msvc",
  ]) {
    const version = canvas.optionalDependencies?.[target];
    if (!version)
      throw new Error(`${target} is not declared by @napi-rs/canvas`);
    // Fetch only while producing a release and verify against package-lock.
    // Deployment targets receive the extracted prebuild and never go online.
    fetchAndCopyPackage(target, version);
  }

  console.log(
    `[runtime] bundled Linux x64 + Windows x64 native dependencies in ${destination}`,
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
