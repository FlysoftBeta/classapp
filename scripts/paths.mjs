import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const worktreeRoot = path.join(projectRoot, "worktree");

export function projectPath(...parts) {
  return path.join(projectRoot, ...parts);
}

export function worktreePath(...parts) {
  return path.join(worktreeRoot, ...parts);
}
