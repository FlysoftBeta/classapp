import { access, cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { worktreePath } from "../paths.mjs";

const dataRoot = worktreePath("data");
const productionDatabase = worktreePath("prod.db");
const developmentDatabase = path.join(dataRoot, "data.db");

await access(productionDatabase);
await mkdir(dataRoot, { recursive: true });
const entries = await readdir(dataRoot);
const databaseFiles = entries
  .filter((name) => name.startsWith("data.db"))
  .map((name) =>
    rm(path.join(dataRoot, name), { recursive: true, force: true }),
  );

await Promise.all([
  ...databaseFiles,
  rm(path.join(dataRoot, "backups"), { recursive: true, force: true }),
  rm(path.join(dataRoot, "blobs"), { recursive: true, force: true }),
]);
await cp(productionDatabase, developmentDatabase);

console.log("Development data reset from worktree/prod.db");
