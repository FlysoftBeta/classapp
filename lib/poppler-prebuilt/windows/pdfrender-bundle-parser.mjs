#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { zstdDecompressSync } from "node:zlib";
import { unzipSync } from "fflate";

function fail(message) {
  throw new Error(`Invalid pdfrender archive: ${message}`);
}

function safePath(name) {
  return (
    !!name &&
    !name.includes("\\") &&
    !path.posix.isAbsolute(name) &&
    !name.split("/").includes("..")
  );
}

function parseArchive(buffer) {
  const files = unzipSync(buffer, {
    filter(info) {
      if (info.compression !== 0) fail(`${info.name} is not STORED`);
      if (!safePath(info.name)) fail(`unsafe ZIP path ${info.name}`);
      return true;
    },
  });
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) fail("missing manifest.json");
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  if (
    manifest.format !== "classapp-render-archive" ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.resources) ||
    !Array.isArray(manifest.files)
  ) {
    fail("unsupported manifest");
  }
  const dictionary = manifest.dictionary
    ? files[manifest.dictionary.path]
    : undefined;
  if (manifest.dictionary && !dictionary) fail("missing dictionary");
  const resources = new Map();
  for (const resource of manifest.resources) {
    const stored = files[resource.path];
    if (!stored || stored.length !== resource.storedSize) {
      fail(`missing or invalid object ${resource.contentId}`);
    }
    let raw;
    if (resource.encoding === "identity") {
      raw = stored;
    } else if (resource.encoding === "zstd") {
      raw = zstdDecompressSync(stored);
    } else if (resource.encoding === "zstd-dictionary" && dictionary) {
      raw = zstdDecompressSync(stored, { dictionary });
    } else {
      fail(`unsupported encoding for ${resource.contentId}`);
    }
    if (raw.length !== resource.rawSize) fail("resource size mismatch");
    if (createHash("sha256").update(raw).digest("hex") !== resource.contentId) {
      fail(`resource hash mismatch ${resource.contentId}`);
    }
    resources.set(resource.contentId, {
      data: Buffer.from(raw),
      mime: resource.mime,
    });
  }
  return { manifest, resources };
}

function rewriteReferences(file, pathsById) {
  if (!file.mime.startsWith("text/")) return file.data;
  let text = file.data.toString("utf8");
  for (const [id, target] of pathsById) {
    if (!text.includes(`data-bundle-ref="${id}"`)) continue;
    let relative = path.posix.relative(path.posix.dirname(file.name), target);
    if (!relative.startsWith(".")) relative = `./${relative}`;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(
      new RegExp(`(src|href)="${escaped}"`, "g"),
      `$1="${relative}"`,
    );
  }
  return Buffer.from(text);
}

async function main() {
  const [, , archiveName, outputName] = process.argv;
  if (!archiveName || !outputName) {
    console.error("Usage: node pdfrender-bundle-parser.mjs input.zip webroot");
    process.exitCode = 2;
    return;
  }
  const parsed = parseArchive(await readFile(archiveName));
  const pathsById = new Map();
  for (const file of parsed.manifest.files) {
    if (!safePath(file.path) || !parsed.resources.has(file.contentId)) {
      fail(`invalid file mapping ${file.path}`);
    }
    if (!pathsById.has(file.contentId)) pathsById.set(file.contentId, file.path);
  }
  await mkdir(outputName, { recursive: true });
  for (const file of parsed.manifest.files) {
    const resource = parsed.resources.get(file.contentId);
    const output = { ...resource, name: file.path };
    const destination = path.join(outputName, ...file.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, rewriteReferences(output, pathsById));
  }
  console.log(
    `Extracted ${parsed.manifest.files.length} files (${parsed.resources.size} unique resources) to ${outputName}`,
  );
}

await main();
