#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { zstdDecompressSync } from "node:zlib";

const MAGIC = Buffer.from([0x50, 0x44, 0x52, 0x42, 0x4e, 0x44, 0x4c, 0x00]);

function fail(message) {
  throw new Error(`Invalid pdfrender bundle: ${message}`);
}

function parseBundle(buffer) {
  let offset = 0;
  const take = (length) => {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset + length > buffer.length
    ) {
      fail("record extends past end of file");
    }
    const result = buffer.subarray(offset, offset + length);
    offset += length;
    return result;
  };
  const u8 = () => take(1)[0];
  const u16 = () => {
    const value = buffer.readUInt16LE(offset);
    take(2);
    return value;
  };
  const u32 = () => {
    const value = buffer.readUInt32LE(offset);
    take(4);
    return value;
  };
  const u64 = () => {
    const value = buffer.readBigUInt64LE(offset);
    take(8);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      fail("record is too large for Node.js");
    return Number(value);
  };

  if (!take(8).equals(MAGIC)) fail("bad magic");
  const version = u16();
  const flags = u16();
  if (version !== 1) fail(`unsupported version ${version}`);
  if (flags !== 1) fail(`unsupported flags ${flags}`);
  const dictionarySize = u32();
  const blobCount = u32();
  const fileCount = u32();
  u32(); // reserved
  const dictionary = take(dictionarySize);
  const blobs = new Map();

  for (let i = 0; i < blobCount; ++i) {
    const id = take(32).toString("hex");
    const mimeLength = u16();
    const encoding = u8();
    u8(); // reserved
    const rawSize = u64();
    const storedSize = u64();
    const mime = take(mimeLength).toString("utf8");
    const stored = take(storedSize);
    let data;
    if (encoding === 0) {
      data = Buffer.from(stored);
    } else if (encoding === 1) {
      data = zstdDecompressSync(stored, { dictionary });
    } else {
      fail(`unknown encoding ${encoding}`);
    }
    if (data.length !== rawSize) fail(`size mismatch for blob ${id}`);
    if (createHash("sha256").update(data).digest("hex") !== id)
      fail(`hash mismatch for blob ${id}`);
    if (encoding === 1 && !mime.startsWith("text/"))
      fail(`non-text blob ${id} is compressed`);
    if (encoding === 0 && mime.startsWith("text/"))
      fail(`text blob ${id} is not compressed`);
    blobs.set(id, { data, mime });
  }

  const files = [];
  for (let i = 0; i < fileCount; ++i) {
    const pathLength = u16();
    u16(); // reserved
    const id = take(32).toString("hex");
    const name = take(pathLength).toString("utf8");
    if (!blobs.has(id)) fail(`path references missing blob ${id}`);
    if (
      !name ||
      name.includes("\\") ||
      path.posix.isAbsolute(name) ||
      name.split("/").includes("..")
    ) {
      fail(`unsafe output path ${JSON.stringify(name)}`);
    }
    files.push({ name, id, ...blobs.get(id) });
  }
  if (offset !== buffer.length) fail("trailing bytes");
  return { dictionarySize, blobs, files };
}

function rewriteReferences(file, filesById) {
  if (!file.mime.startsWith("text/") && file.mime !== "image/svg+xml")
    return file.data;
  let text = file.data.toString("utf8");
  for (const [id, target] of filesById) {
    if (!text.includes(`data-pdfrender-ref="${id}"`)) continue;
    let relative = path.posix.relative(path.posix.dirname(file.name), target);
    if (!relative.startsWith(".")) relative = `./${relative}`;
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(
      new RegExp(`(src|href|data)="${escapedId}"`, "g"),
      `$1="${relative}"`,
    );
  }
  return Buffer.from(text);
}

async function main() {
  const [, , bundleName, outputName] = process.argv;
  if (!bundleName || !outputName) {
    console.error("Usage: node pdfrender-bundle-parser.mjs input.pdrb webroot");
    process.exitCode = 2;
    return;
  }
  const parsed = parseBundle(await readFile(bundleName));
  const filesById = new Map();
  for (const file of parsed.files) {
    if (!filesById.has(file.id)) filesById.set(file.id, file.name);
  }
  await mkdir(outputName, { recursive: true });
  for (const file of parsed.files) {
    const destination = path.join(outputName, ...file.name.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, rewriteReferences(file, filesById));
  }
  console.log(
    `Extracted ${parsed.files.length} files (${parsed.blobs.size} unique blobs, ${parsed.dictionarySize} dictionary bytes) to ${outputName}`,
  );
}

await main();
