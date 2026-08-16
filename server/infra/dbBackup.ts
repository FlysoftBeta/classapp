import fs from "fs";
import path from "path";
import type { Database } from "better-sqlite3";
import { zipSingleFile } from "./archive";
import { PublicError } from "@/server/services/incidentService";
import { runtimeConfig } from "@/server/infra/runtimeConfig";

export const MAX_BACKUPS = 5;
/** Backups are zipped in memory for download; refuse absurdly large files. */
export const MAX_BACKUP_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

const BACKUP_NAME_RE = /^[\w.-]+\.db$/;

function backupDir(): string {
  return path.join(runtimeConfig().dataRoot, "backups");
}

function databasePath(): string {
  return path.join(runtimeConfig().dataRoot, "data.db");
}

export function ensureBackupDir(): void {
  fs.mkdirSync(backupDir(), { recursive: true });
}

export function listBackupFiles(): {
  name: string;
  size: number;
  created_at: string;
}[] {
  ensureBackupDir();
  return fs
    .readdirSync(backupDir())
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const stat = fs.statSync(path.join(backupDir(), f));
      return { name: f, size: stat.size, created_at: stat.mtime.toISOString() };
    })
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
}

/** Resolve and validate a backup filename; throws PublicError if invalid or missing. */
export function resolveBackupFile(name: string): string {
  if (!name || !BACKUP_NAME_RE.test(name)) throw new PublicError("文件名无效");

  const filePath = path.join(backupDir(), name);
  if (!fs.existsSync(filePath)) throw new PublicError("备份不存在");

  return filePath;
}

export function backupFilePath(name: string): string {
  return path.join(backupDir(), name);
}

/** Snapshot data.db via SQLite backup API; returns the backup filename. */
export async function createDbBackup(db: Database): Promise<string | null> {
  if (!fs.existsSync(databasePath())) return null;

  ensureBackupDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `data-${ts}.db`;
  const dest = backupFilePath(name);

  try {
    await db.backup(dest);
  } catch (e) {
    throw new PublicError("数据库备份失败", "SQLite backup failed", e);
  }

  for (const extra of listBackupFiles().slice(MAX_BACKUPS)) {
    fs.unlinkSync(backupFilePath(extra.name));
  }
  return name;
}

export function deleteBackup(name: string): void {
  fs.unlinkSync(resolveBackupFile(name));
}

export function buildBackupDownload(name: string): {
  zipName: string;
  zipData: Uint8Array;
} {
  const filePath = resolveBackupFile(name);
  try {
    const size = fs.statSync(filePath).size;
    if (size > MAX_BACKUP_DOWNLOAD_BYTES) {
      throw new PublicError("备份文件过大，无法打包下载");
    }
    return {
      zipName: name.replace(/\.db$/, ".zip"),
      zipData: zipSingleFile(filePath, name),
    };
  } catch (e) {
    if (e instanceof PublicError) throw e;
    throw new PublicError("打包失败", "Backup archive creation failed", e);
  }
}
