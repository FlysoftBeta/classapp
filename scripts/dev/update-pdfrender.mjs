#!/usr/bin/env node
/** Manually refresh committed pdfrender binaries from a successful Actions run. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { resolveBuildCache } from "../builds/build-cache.mjs";
import { projectRoot } from "../paths.mjs";

const root = projectRoot;
const repository = "FlysoftBeta/pdf-render";
const workflow = "pdfrender.yml";
const prebuiltRoot = path.join(root, "lib", "poppler-prebuilt");
const artifactDefinitions = [
  {
    name: "pdfrender-linux-debian-x86_64",
    archive: "pdfrender-linux-debian-x86_64.tar.gz",
    destination: "linux-debian",
    executable: "pdfrender",
    format: "tar.gz",
  },
  {
    name: "pdfrender-linux-redhat-x86_64",
    archive: "pdfrender-linux-redhat-x86_64.tar.gz",
    destination: "linux-redhat",
    executable: "pdfrender",
    format: "tar.gz",
  },
  {
    name: "pdfrender-windows-x86_64",
    archive: "pdfrender-windows-x86_64.zip",
    destination: "windows",
    executable: "pdfrender.exe",
    format: "zip",
  },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

function ghJson(args) {
  return JSON.parse(run("gh", args));
}

function parseArguments(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--run" && /^\d+$/.test(args[1])) {
    return { runId: Number(args[1]) };
  }
  if (args.length === 1 && /^--run=\d+$/.test(args[0])) {
    return { runId: Number(args[0].slice("--run=".length)) };
  }
  throw new Error(
    "Usage: npm run pdfrender:update [-- --run <successful-run-id>]",
  );
}

function resolveRun(requestedRunId) {
  if (requestedRunId) {
    const selected = ghJson([
      "run",
      "view",
      String(requestedRunId),
      "--repo",
      repository,
      "--json",
      "databaseId,headSha,status,conclusion,createdAt,url",
    ]);
    if (selected.status !== "completed" || selected.conclusion !== "success") {
      throw new Error(`Actions run ${requestedRunId} is not successful`);
    }
    return selected;
  }

  const [latest] = ghJson([
    "run",
    "list",
    "--repo",
    repository,
    "--workflow",
    workflow,
    "--status",
    "success",
    "--limit",
    "1",
    "--json",
    "databaseId,headSha,status,conclusion,createdAt,url",
  ]);
  if (!latest) throw new Error(`No successful ${workflow} run found`);
  return latest;
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function cacheManifestFor(runInfo, artifactMetadata, runCache) {
  return {
    schemaVersion: 1,
    runId: runInfo.databaseId,
    artifacts: Object.fromEntries(
      artifactDefinitions.map(({ name, archive }) => {
        const metadata = artifactMetadata.get(name);
        const archivePath = path.join(runCache, name, archive);
        return [
          name,
          {
            githubDigest: metadata.digest,
            archive,
            archiveDigest: `sha256:${sha256(archivePath)}`,
          },
        ];
      }),
    ),
  };
}

function validCache(runInfo, artifactMetadata, runCache) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runCache, "cache-manifest.json"), "utf8"),
    );
    if (manifest.schemaVersion !== 1 || manifest.runId !== runInfo.databaseId) {
      return false;
    }
    return artifactDefinitions.every(({ name, archive }) => {
      const cached = manifest.artifacts?.[name];
      const archivePath = path.join(runCache, name, archive);
      return (
        cached?.githubDigest === artifactMetadata.get(name).digest &&
        cached.archive === archive &&
        cached.archiveDigest === `sha256:${sha256(archivePath)}`
      );
    });
  } catch {
    return false;
  }
}

function downloadArtifacts(runInfo, artifactMetadata, cacheRoot) {
  const runCache = path.join(cacheRoot, String(runInfo.databaseId));
  if (validCache(runInfo, artifactMetadata, runCache)) {
    console.log(`[pdfrender] artifact cache hit: run ${runInfo.databaseId}`);
    return runCache;
  }

  fs.mkdirSync(cacheRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(cacheRoot, ".download-"));
  try {
    const names = artifactDefinitions.flatMap(({ name }) => ["--name", name]);
    run(
      "gh",
      [
        "run",
        "download",
        String(runInfo.databaseId),
        "--repo",
        repository,
        "--dir",
        staging,
        ...names,
      ],
      { stdio: "inherit" },
    );
    for (const { name, archive } of artifactDefinitions) {
      if (!fs.existsSync(path.join(staging, name, archive))) {
        throw new Error(`${name} did not contain ${archive}`);
      }
    }
    fs.writeFileSync(
      path.join(staging, "cache-manifest.json"),
      `${JSON.stringify(
        cacheManifestFor(runInfo, artifactMetadata, staging),
        null,
        2,
      )}\n`,
    );
    fs.rmSync(runCache, { recursive: true, force: true });
    fs.renameSync(staging, runCache);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  console.log(
    `[pdfrender] downloaded artifacts from run ${runInfo.databaseId}`,
  );
  return runCache;
}

function extractArtifact(definition, archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (definition.format === "tar.gz") {
    run("tar", ["-xzf", archive, "-C", destination], { stdio: "inherit" });
  } else {
    run("unzip", ["-q", archive, "-d", destination], {
      stdio: "inherit",
    });
  }

  const extracted = path.join(destination, definition.name);
  for (const required of [
    definition.executable,
    "pdfrender-bundle-parser.mjs",
    "pdfrender.md",
    "COPYING",
    "COPYING3",
    path.join("share", "poppler", "cidToUnicode", "Adobe-GB1"),
    path.join("share", "poppler", "cMap", "Adobe-GB1", "Adobe-GB1-UCS2"),
    path.join("licenses", "poppler-data"),
  ]) {
    if (!fs.existsSync(path.join(extracted, required))) {
      throw new Error(`${definition.name} is missing ${required}`);
    }
  }
  if (definition.executable === "pdfrender") {
    fs.chmodSync(path.join(extracted, definition.executable), 0o755);
  }
  return extracted;
}

function replacePrebuilts(runInfo, artifactMetadata, runCache) {
  const libDirectory = path.dirname(prebuiltRoot);
  const stagingRoot = fs.mkdtempSync(
    path.join(libDirectory, ".poppler-prebuilt-update-"),
  );
  const extractionRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "classapp-pdfrender-update-"),
  );
  const next = path.join(stagingRoot, "next");
  const previous = path.join(stagingRoot, "previous");

  try {
    fs.mkdirSync(next);
    for (const definition of artifactDefinitions) {
      const archive = path.join(runCache, definition.name, definition.archive);
      const extracted = extractArtifact(
        definition,
        archive,
        path.join(extractionRoot, definition.destination),
      );
      fs.cpSync(extracted, path.join(next, definition.destination), {
        recursive: true,
      });
    }

    const cacheManifest = JSON.parse(
      fs.readFileSync(path.join(runCache, "cache-manifest.json"), "utf8"),
    );
    const manifest = {
      schemaVersion: 1,
      repository,
      workflow,
      run: {
        id: runInfo.databaseId,
        headSha: runInfo.headSha,
        createdAt: runInfo.createdAt,
        url: runInfo.url,
      },
      artifacts: Object.fromEntries(
        artifactDefinitions.map(({ name, destination }) => {
          const metadata = artifactMetadata.get(name);
          return [
            destination,
            {
              id: metadata.id,
              name,
              size: metadata.size_in_bytes,
              githubDigest: metadata.digest,
              archiveDigest: cacheManifest.artifacts[name].archiveDigest,
            },
          ];
        }),
      ),
    };
    fs.writeFileSync(
      path.join(next, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    fs.renameSync(prebuiltRoot, previous);
    try {
      fs.renameSync(next, prebuiltRoot);
    } catch (error) {
      fs.renameSync(previous, prebuiltRoot);
      throw error;
    }
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function main() {
  const { runId } = parseArguments(process.argv.slice(2));
  const runInfo = resolveRun(runId);
  const sourceHead = run("git", ["-C", "lib/poppler", "rev-parse", "HEAD"]);
  if (sourceHead !== runInfo.headSha) {
    throw new Error(
      `Selected run was built from ${runInfo.headSha}, but lib/poppler is ${sourceHead}. Update the submodule first.`,
    );
  }

  const response = ghJson([
    "api",
    `repos/${repository}/actions/runs/${runInfo.databaseId}/artifacts?per_page=100`,
  ]);
  const artifactMetadata = new Map(
    response.artifacts.map((artifact) => [artifact.name, artifact]),
  );
  const missing = artifactDefinitions.filter(
    ({ name }) =>
      !artifactMetadata.has(name) || artifactMetadata.get(name).expired,
  );
  if (missing.length > 0) {
    throw new Error(
      `Run ${runInfo.databaseId} has missing or expired artifacts: ${missing.map(({ name }) => name).join(", ")}`,
    );
  }

  const cacheRoot = path.join(resolveBuildCache(), "pdfrender-actions");
  const runCache = downloadArtifacts(runInfo, artifactMetadata, cacheRoot);
  replacePrebuilts(runInfo, artifactMetadata, runCache);
  console.log(
    `[pdfrender] updated lib/poppler-prebuilt from ${runInfo.url} (${runInfo.headSha.slice(0, 12)})`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
