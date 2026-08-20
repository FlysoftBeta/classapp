import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { PublicError } from "@/server/services/incidentService";
import {
  extractDeployArchive,
  REQUIRED_DEPLOY_DIRECTORIES,
  REQUIRED_DEPLOY_FILES,
} from "@/server/runtime/update/archive";

const text = (value: string) => new TextEncoder().encode(value);

function validDeployFiles(): Record<string, Uint8Array> {
  return {
    "server.js": text("server"),
    "shell.html": text("<html></html>"),
    "client/app.js": text("client"),
    "server/main.mjs": text("main"),
    "node_modules/ws/index.js": text("ws"),
  };
}

async function withStaging(
  run: (staging: string) => Promise<void>,
): Promise<void> {
  const staging = await mkdtemp(path.join(os.tmpdir(), "classapp-deploy-"));
  try {
    await run(staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function extract(files: Record<string, Uint8Array>, staging: string): void {
  extractDeployArchive(zipSync(files, { level: 0 }), staging);
}

test("a complete deploy archive extracts required runtime files", async () => {
  await withStaging(async (staging) => {
    extract(validDeployFiles(), staging);
    for (const file of REQUIRED_DEPLOY_FILES) {
      assert.equal(
        (await readFile(path.join(staging, file), "utf8")).length > 0,
        true,
      );
    }
    for (const directory of REQUIRED_DEPLOY_DIRECTORIES) {
      assert.equal(
        fs.statSync(path.join(staging, directory)).isDirectory(),
        true,
      );
    }
    assert.equal(
      await readFile(path.join(staging, "client/app.js"), "utf8"),
      "client",
    );
  });
});

test("empty, unreadable, and incomplete archives fail closed before switch", async () => {
  await withStaging(async (staging) => {
    assert.throws(
      () => extractDeployArchive(new Uint8Array(), staging),
      (error: unknown) =>
        error instanceof PublicError &&
        error.publicMessage === "更新包大小无效",
    );
    assert.throws(
      () => extractDeployArchive(text("not-a-zip"), staging),
      (error: unknown) =>
        error instanceof PublicError &&
        error.publicMessage === "更新包无法解压",
    );
    assert.throws(
      () => extract({ "readme.txt": text("hello") }, staging),
      (error: unknown) =>
        error instanceof PublicError &&
        error.publicMessage === "更新包缺少 server.js",
    );
    assert.equal(fs.readdirSync(staging).length, 0);
  });
});

test("path traversal and colliding zip names are rejected", async () => {
  await withStaging(async (staging) => {
    assert.throws(
      () =>
        extract({ "../secret": text("no"), ...validDeployFiles() }, staging),
      (error: unknown) =>
        error instanceof PublicError &&
        error.publicMessage === "更新包包含非法路径",
    );
    assert.throws(
      () =>
        extract(
          {
            ...validDeployFiles(),
            "./server.js": text("other"),
          },
          staging,
        ),
      (error: unknown) =>
        error instanceof PublicError &&
        error.publicMessage === "更新包包含重复路径",
    );
    assert.equal(fs.existsSync(path.join(staging, "..", "secret")), false);
  });
});
