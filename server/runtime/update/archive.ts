import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { PublicError } from "@/server/services/incidentService";

/** Matches the HTTP deploy upload bound; uncompressed output is allowed some expansion. */
export const MAX_DEPLOY_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_DEPLOY_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_DEPLOY_ENTRY_BYTES = 512 * 1024 * 1024;
export const MAX_DEPLOY_ENTRY_COUNT = 200_000;

export const REQUIRED_DEPLOY_FILES = ["server.js", "shell.html"] as const;
export const REQUIRED_DEPLOY_DIRECTORIES = [
  "client",
  "server",
  "node_modules",
] as const;

function normalizeZipPath(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function assertSafeStagingPath(root: string, zipName: string): string {
  const normalized = normalizeZipPath(zipName);
  if (
    !normalized ||
    normalized.endsWith("/") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === ".")
  ) {
    throw new PublicError("更新包包含非法路径");
  }
  if (normalized.split("/").includes("..")) {
    throw new PublicError("更新包包含非法路径");
  }
  const outPath = path.resolve(root, normalized);
  if (outPath === root || !outPath.startsWith(`${root}${path.sep}`)) {
    throw new PublicError("更新包包含非法路径");
  }
  return outPath;
}

function requireArchiveLayout(names: string[]): void {
  const normalized = names.map(normalizeZipPath);
  for (const file of REQUIRED_DEPLOY_FILES) {
    if (!normalized.includes(file)) {
      throw new PublicError(`更新包缺少 ${file}`);
    }
  }
  for (const directory of REQUIRED_DEPLOY_DIRECTORIES) {
    const prefix = `${directory}/`;
    if (
      !normalized.some((name) => name === directory || name.startsWith(prefix))
    ) {
      throw new PublicError(`更新包缺少 ${directory}/`);
    }
  }
}

function requireStagingLayout(destDir: string): void {
  for (const file of REQUIRED_DEPLOY_FILES) {
    const candidate = path.join(destDir, file);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      throw new PublicError(`更新包缺少 ${file}`);
    }
  }
  for (const directory of REQUIRED_DEPLOY_DIRECTORIES) {
    const candidate = path.join(destDir, directory);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      throw new PublicError(`更新包缺少 ${directory}/`);
    }
  }
}

/** Extract a deploy archive and reject it before any launcher switch. */
export function extractDeployArchive(
  zipBytes: Uint8Array,
  destDir: string,
): void {
  if (
    zipBytes.byteLength === 0 ||
    zipBytes.byteLength > MAX_DEPLOY_ARCHIVE_BYTES
  ) {
    throw new PublicError("更新包大小无效");
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zipBytes);
  } catch (error) {
    throw new PublicError(
      "更新包无法解压",
      "Deploy archive unzip failed",
      error,
    );
  }

  const root = path.resolve(destDir);
  const written = new Map<string, string>();
  let uncompressed = 0;
  let fileCount = 0;

  for (const [name, data] of Object.entries(files)) {
    if (!name || name.endsWith("/")) continue;
    fileCount += 1;
    if (fileCount > MAX_DEPLOY_ENTRY_COUNT) {
      throw new PublicError("更新包文件数量超过限制");
    }
    if (data.byteLength > MAX_DEPLOY_ENTRY_BYTES) {
      throw new PublicError("更新包含有过大的文件");
    }
    uncompressed += data.byteLength;
    if (uncompressed > MAX_DEPLOY_UNCOMPRESSED_BYTES) {
      throw new PublicError("更新包解压后超过大小限制");
    }
    const outPath = assertSafeStagingPath(root, name);
    const previous = written.get(outPath);
    if (previous && previous !== name) {
      throw new PublicError("更新包包含重复路径");
    }
    written.set(outPath, name);
  }

  if (written.size === 0) {
    throw new PublicError("更新包是空的");
  }
  requireArchiveLayout([...written.values()]);

  for (const [outPath, name] of written) {
    const data = files[name];
    if (!data) throw new PublicError("更新包无法解压");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
  }

  requireStagingLayout(root);
}
