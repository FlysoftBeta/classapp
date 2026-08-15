import { createHash } from "node:crypto";
import { z } from "zod";

export const UPDATE_MANIFEST_FORMAT = "classapp-update-v1";
export const MAX_UPDATE_PART_BYTES = 100_000_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;

const urlSchema = z.string().min(1).max(2048).url();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const partSchema = z
  .object({
    filename: z.string().min(1).max(255),
    url: urlSchema,
    size: z.number().int().positive().max(MAX_UPDATE_PART_BYTES),
    sha256: sha256Schema,
  })
  .strict();

export const cloudUpdateManifestSchema = z
  .object({
    format: z.literal(UPDATE_MANIFEST_FORMAT),
    buildId: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    archive: z
      .object({
        filename: z.string().min(1).max(255),
        size: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
        sha256: sha256Schema,
      })
      .strict(),
    parts: z.array(partSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const size = manifest.parts.reduce((total, part) => total + part.size, 0);
    if (size !== manifest.archive.size) {
      context.addIssue({
        code: "custom",
        path: ["parts"],
        message: "分片总大小与 archive 不一致",
      });
    }
  });

export type CloudUpdateManifest = z.infer<typeof cloudUpdateManifestSchema>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseCloudUpdateManifest(value: unknown): CloudUpdateManifest {
  return cloudUpdateManifestSchema.parse(value);
}

async function fetchBytes(
  url: string,
  maximum: number,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetcher(url, {
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(5 * 60 * 1000),
    headers: { "user-agent": "ClassApp-UpdateManager" },
  });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new Error("下载内容超过允许大小");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("下载内容超过允许大小");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchCloudUpdateManifest(
  manifestUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<CloudUpdateManifest> {
  const url = urlSchema.parse(manifestUrl);
  const bytes = await fetchBytes(url, MAX_MANIFEST_BYTES, fetcher);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("更新 manifest 不是有效 JSON");
  }
  return parseCloudUpdateManifest(value);
}

export async function downloadCloudUpdate(
  manifest: CloudUpdateManifest,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const archive = new Uint8Array(manifest.archive.size);
  let offset = 0;
  for (const part of manifest.parts) {
    const bytes = await fetchBytes(part.url, part.size, fetcher);
    if (bytes.byteLength !== part.size) {
      throw new Error(`更新分片 ${part.filename} 大小不符`);
    }
    if (sha256(bytes) !== part.sha256) {
      throw new Error(`更新分片 ${part.filename} 校验失败`);
    }
    archive.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (sha256(archive) !== manifest.archive.sha256) {
    throw new Error("更新包整体校验失败");
  }
  return archive;
}
