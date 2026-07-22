import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const infini2Dir = resolve(scriptDir, "..");
const docsDir = resolve(infini2Dir, "docs");
const manifest = resolve(infini2Dir, "rust", "Cargo.toml");

function markdownFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory()
      ? markdownFiles(path)
      : extname(path) === ".md"
        ? [path]
        : [];
  });
}

const failures = [];
for (const file of [
  resolve(infini2Dir, "README.md"),
  ...markdownFiles(docsDir),
]) {
  const source = readFileSync(file, "utf8");
  const links = source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (/^(?:[a-z]+:|#)/i.test(rawTarget)) continue;
    const pathPart = rawTarget.split("#", 1)[0];
    if (!pathPart) continue;
    const target = resolve(dirname(file), decodeURIComponent(pathPart));
    if (!existsSync(target)) {
      failures.push(`${file}: missing link target ${rawTarget}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Infini2 Markdown links: ok");

const cargo = spawnSync(
  "cargo",
  ["doc", "--manifest-path", manifest, "--locked", "--no-deps"],
  {
    cwd: infini2Dir,
    env: {
      ...process.env,
      RUSTDOCFLAGS: [process.env.RUSTDOCFLAGS, "-D", "warnings"]
        .filter(Boolean)
        .join(" "),
    },
    encoding: "utf8",
    stdio: "inherit",
  },
);
if (cargo.error) throw cargo.error;
if (cargo.status !== 0) process.exit(cargo.status ?? 1);

const doctest = spawnSync(
  "cargo",
  ["test", "--manifest-path", manifest, "--locked", "--doc"],
  {
    cwd: infini2Dir,
    env: {
      ...process.env,
      RUSTDOCFLAGS: [process.env.RUSTDOCFLAGS, "-D", "warnings"]
        .filter(Boolean)
        .join(" "),
    },
    encoding: "utf8",
    stdio: "inherit",
  },
);
if (doctest.error) throw doctest.error;
process.exit(doctest.status ?? 1);
