import fs from "fs";
import path from "path";
import { unzipSync, zipSync } from "fflate";

/** Extract a zip archive's contents into destDir, creating directories as needed. */
export function extractZipToDir(zipBytes: Uint8Array, destDir: string): void {
  const files = unzipSync(zipBytes);
  const root = path.resolve(destDir);
  for (const [name, data] of Object.entries(files)) {
    if (!name || name.endsWith("/")) continue; // skip directory entries
    // Guard against path traversal (e.g. "../../etc/...")
    const outPath = path.resolve(root, name);
    if (outPath !== root && !outPath.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
  }
}

/** Read a single file and return it packed into an in-memory zip (one entry). */
export function zipSingleFile(srcPath: string, entryName: string): Uint8Array {
  const data = fs.readFileSync(srcPath);
  return zipSync({ [entryName]: [new Uint8Array(data), { level: 6 }] });
}

/** Pack already-materialized files without exposing archive mechanics to services. */
export function zipFiles(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 6 });
}
