#!/usr/bin/env node
import fs, { openAsBlob } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { projectRoot, worktreePath } from "../paths.mjs";

const TAG = "deploy";
const MANIFEST_FILENAME = "manifest.json";
const PART_BYTES = 100_000_000;
const API_ROOT = "https://gitee.com/api/v5";
const giteeConfigSchema = z
  .object({
    accessToken: z.string().min(1),
    owner: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    repository: z
      .string()
      .regex(/^[^/]+\/[^/]+$/)
      .optional(),
    targetCommitish: z.string().min(1).default("master"),
  })
  .strict()
  .refine((value) => Boolean((value.owner && value.repo) || value.repository), {
    message: "必须设置 owner + repo 或 repository",
  })
  .transform((value) => {
    const repository = value.repository?.split("/") ?? [];
    return {
      accessToken: value.accessToken,
      owner: value.owner ?? repository[0],
      repo: value.repo ?? repository[1],
      targetCommitish: value.targetCommitish,
    };
  });

function usage() {
  return "Usage: npm run deploy-gitee -- <path-to-deploy.zip>";
}

function readConfig() {
  const filename = worktreePath("secrets", "gitee.json");
  if (!fs.existsSync(filename)) throw new Error(`缺少配置：${filename}`);
  return giteeConfigSchema.parse(JSON.parse(fs.readFileSync(filename, "utf8")));
}

function sha256(filename) {
  const hash = createHash("sha256");
  const fd = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function readBuildId(archive) {
  const result = spawnSync("unzip", ["-p", archive, "build-id.txt"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("无法从更新包读取 build-id.txt");
  }
  return result.stdout.trim();
}

function splitArchive(archive, directory) {
  const base = path.basename(archive);
  const input = fs.openSync(archive, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const parts = [];
  let position = 0;
  try {
    for (let index = 1; position < fs.statSync(archive).size; index += 1) {
      const filename = `${base}.part-${String(index).padStart(3, "0")}`;
      const outputPath = path.join(directory, filename);
      const output = fs.openSync(outputPath, "w");
      let partSize = 0;
      try {
        while (partSize < PART_BYTES) {
          const wanted = Math.min(buffer.length, PART_BYTES - partSize);
          const count = fs.readSync(input, buffer, 0, wanted, position);
          if (!count) break;
          let written = 0;
          while (written < count) {
            written += fs.writeSync(output, buffer, written, count - written);
          }
          position += count;
          partSize += count;
        }
      } finally {
        fs.closeSync(output);
      }
      parts.push({ filename, path: outputPath, size: partSize });
    }
  } finally {
    fs.closeSync(input);
  }
  return parts;
}

async function api(config, pathname, options = {}) {
  const response = await fetch(`${API_ROOT}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const detail =
      body && typeof body === "object"
        ? body.message || body.error || JSON.stringify(body)
        : body;
    throw new Error(`Gitee API ${response.status}: ${detail || "请求失败"}`);
  }
  return body;
}

function repositoryPath(config) {
  return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
}

async function deletePreviousRelease(config) {
  const query = new URLSearchParams({ access_token: config.accessToken });
  const response = await fetch(
    `${API_ROOT}${repositoryPath(config)}/releases/tags/${TAG}?${query}`,
  );
  if (response.status === 404) return;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`查询旧 Release 失败：HTTP ${response.status} ${text}`);
  }
  const release = JSON.parse(text);
  if (!release.id) throw new Error("Gitee 返回的旧 Release 缺少 id");
  await api(config, `${repositoryPath(config)}/releases/${release.id}`, {
    method: "DELETE",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: config.accessToken }),
  });
  console.log(`已删除旧 Release（tag: ${TAG}）`);
}

async function createRelease(config, buildId) {
  return api(config, `${repositoryPath(config)}/releases`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      access_token: config.accessToken,
      tag_name: TAG,
      name: `ClassApp ${buildId}`,
      body: `ClassApp automated deployment ${buildId}`,
      target_commitish: config.targetCommitish,
    }),
  });
}

async function uploadAttachment(config, releaseId, filename, uploadPath) {
  const form = new FormData();
  form.append("access_token", config.accessToken);
  form.append("file", await openAsBlob(uploadPath), filename);
  await api(
    config,
    `${repositoryPath(config)}/releases/${releaseId}/attach_files`,
    { method: "POST", body: form },
  );
  console.log(`已上传 ${filename}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error(usage());
  const archive = path.resolve(projectRoot, args[0]);
  if (!fs.existsSync(archive) || !fs.statSync(archive).isFile()) {
    throw new Error(`更新包不存在：${archive}`);
  }
  const config = readConfig();
  const buildId = readBuildId(archive);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "classapp-gitee-"));
  try {
    const parts = splitArchive(archive, temporary);
    const manifest = {
      format: "classapp-update-v1",
      buildId,
      createdAt: new Date().toISOString(),
      archive: {
        filename: path.basename(archive),
        size: fs.statSync(archive).size,
        sha256: sha256(archive),
      },
      parts: parts.map((part) => ({
        filename: part.filename,
        url: `https://gitee.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/releases/download/${TAG}/${encodeURIComponent(part.filename)}`,
        size: part.size,
        sha256: sha256(part.path),
      })),
    };
    const manifestPath = path.join(temporary, MANIFEST_FILENAME);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await deletePreviousRelease(config);
    const release = await createRelease(config, buildId);
    if (!release?.id) throw new Error("Gitee 创建 Release 后未返回 id");
    for (const part of parts) {
      await uploadAttachment(config, release.id, part.filename, part.path);
    }
    await uploadAttachment(config, release.id, MANIFEST_FILENAME, manifestPath);
    console.log(
      `Manifest: https://gitee.com/${config.owner}/${config.repo}/releases/download/${TAG}/${MANIFEST_FILENAME}`,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
