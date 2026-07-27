import { access, cp, readdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const productionDatabase = path.join(root, "prod.db");
const developmentDatabase = path.join(root, "data.db");

await access(productionDatabase);
const entries = await readdir(root);
const databaseFiles = entries
  .filter((name) => name.startsWith("data.db"))
  .map((name) => rm(path.join(root, name), { recursive: true, force: true }));

await Promise.all([
  ...databaseFiles,
  rm(path.join(root, "backups"), { recursive: true, force: true }),
  rm(path.join(root, "blobs"), { recursive: true, force: true }),
]);
await cp(productionDatabase, developmentDatabase);

console.log("Development data reset from prod.db");
