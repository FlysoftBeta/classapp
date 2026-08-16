#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { resolveBuildCache } from "./build-cache.mjs";
import { BUILD_TARGET_NAMES, resolveBuildTarget } from "./build-targets.mjs";
import { prepareRuntimeDependencies } from "./runtime-deps.mjs";
import { assembleMediaArtifacts } from "./build-media.mjs";
import { projectRoot, worktreePath } from "../paths.mjs";

const root = projectRoot;

function usage() {
  return `Usage: npm run build -- <target>\nTargets: ${BUILD_TARGET_NAMES.join(", ")}`;
}

function parseTargetArgument(args) {
  if (args.length === 1 && !args[0].startsWith("--")) return args[0];
  if (args.length === 2 && args[0] === "--target") return args[1];
  if (args.length === 1 && args[0].startsWith("--target=")) {
    return args[0].slice("--target=".length);
  }
  throw new Error(usage());
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
}

function gitBuildId() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      "CLASSAPP_BUILD_ID is unset and git could not resolve HEAD",
    );
  }
  return result.stdout.trim();
}

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function copyHttpsFiles(dist) {
  const source = worktreePath("secrets", "https");
  const names = ["config.json", "fullchain.pem", "privkey.pem", "root.pem"];
  if (names.every((name) => fs.existsSync(path.join(source, name)))) {
    const destination = path.join(dist, "https");
    fs.mkdirSync(destination, { recursive: true });
    for (const name of names) {
      copy(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  if (process.env.CLASSAPP_REQUIRE_HTTPS === "1") {
    throw new Error(
      "HTTPS deployment files are missing. Run: npm run https:renew",
    );
  }
  console.warn(
    "HTTPS deployment files not found; building without HTTPS credentials.",
  );
}

function copyModelsFile(dist) {
  const source = worktreePath("secrets", "models.json");
  if (!fs.existsSync(source)) {
    console.warn(
      "AI models configuration not found; building with AI unavailable.",
    );
    return;
  }
  const destination = path.join(dist, "models.json");
  copy(source, destination);
  fs.chmodSync(destination, 0o600);
}

function createZip(source, destination) {
  fs.rmSync(destination, { force: true });
  run("zip", ["-rq", destination, "."], { cwd: source });
}

function assemblePrivateSourceMaps(dist, buildId) {
  const directory = path.join(dist, "server", "source-maps");
  fs.mkdirSync(directory, { recursive: true });
  const artifacts = [
    {
      environment: "client",
      source: path.join(dist, "client", "app.js.map"),
      file: "client-app.js.map",
    },
    {
      environment: "server",
      source: path.join(dist, "server", "main.mjs.map"),
      file: "server-main.mjs.map",
    },
  ];
  for (const artifact of artifacts) {
    if (!fs.existsSync(artifact.source)) {
      throw new Error(`Missing ${artifact.environment} source map`);
    }
    const sourceMap = JSON.parse(fs.readFileSync(artifact.source, "utf8"));
    sourceMap.sourceRoot = "";
    sourceMap.sources = sourceMap.sources.map((source) => {
      const absolute = path.resolve(path.dirname(artifact.source), source);
      const relative = path.relative(root, absolute);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative.split(path.sep).join("/");
      }
      return path.basename(source);
    });
    fs.writeFileSync(
      path.join(directory, artifact.file),
      JSON.stringify(sourceMap),
    );
    fs.unlinkSync(artifact.source);
  }
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      format: "classapp-source-maps-v1",
      buildId,
      maps: Object.fromEntries(
        artifacts.map(({ environment, file }) => [environment, file]),
      ),
    }),
  );
}

function build(targetName) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Release assembly must run on Linux x64.");
  }

  const target = resolveBuildTarget(targetName);
  const buildId = process.env.CLASSAPP_BUILD_ID || gitBuildId();
  process.env.CLASSAPP_BUILD_ID = buildId;

  const buildCache = resolveBuildCache();
  const dist = path.join(buildCache, "dist");
  const buildDirectory = path.join(root, "build");
  const deployment = path.join(buildCache, "deploy");
  const current = path.join(deployment, "current");
  const deployZip = path.join(buildDirectory, `deploy-${targetName}.zip`);
  const bootstrapZip = path.join(buildDirectory, `bootstrap-${targetName}.zip`);
  const rendererSource = path.join(root, target.rendererSource);
  const rendererDestination = path.join(
    dist,
    "server",
    "pdfrender",
    target.rendererDestination,
  );

  if (!fs.existsSync(rendererSource)) {
    throw new Error(
      `Missing pdfrender files for ${targetName}: ${rendererSource}`,
    );
  }

  fs.rmSync(dist, { recursive: true, force: true });
  fs.rmSync(deployment, { recursive: true, force: true });
  fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
  fs.rmSync(path.join(buildDirectory, "deploy"), {
    recursive: true,
    force: true,
  });
  fs.rmSync(deployZip, { force: true });
  fs.rmSync(bootstrapZip, { force: true });
  fs.mkdirSync(buildDirectory, { recursive: true });

  run("npm", ["run", "infini:build"]);
  run("npm", ["run", "zstd:build"]);

  const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
  run(process.execPath, [vite, "build", "--outDir", path.join(dist, "client")]);
  run(process.execPath, [
    vite,
    "build",
    "--config",
    "vite.server.config.ts",
    "--outDir",
    path.join(dist, "server"),
  ]);
  assemblePrivateSourceMaps(dist, buildId);
  copy(rendererSource, rendererDestination);
  run(process.execPath, [
    vite,
    "build",
    "--config",
    "vite.bootstrap.config.ts",
    "--outDir",
    dist,
  ]);
  run(process.execPath, [
    vite,
    "build",
    "--config",
    "vite.launcher.config.ts",
    "--outDir",
    dist,
  ]);
  fs.writeFileSync(path.join(dist, "build-id.txt"), buildId);
  copyHttpsFiles(dist);
  copyModelsFile(dist);

  copy(path.join(dist, "client"), path.join(current, "client"));
  copy(path.join(dist, "server"), path.join(current, "server"));
  copy(path.join(root, "public"), path.join(current, "public"));
  copy(path.join(root, "shell.html"), path.join(current, "shell.html"));
  copy(path.join(dist, "server.js"), path.join(current, "server.js"));
  copy(path.join(dist, "build-id.txt"), path.join(current, "build-id.txt"));
  if (fs.existsSync(path.join(dist, "https"))) {
    copy(path.join(dist, "https"), path.join(current, "https"));
  }
  if (fs.existsSync(path.join(dist, "models.json"))) {
    copy(path.join(dist, "models.json"), path.join(current, "models.json"));
  }

  assembleMediaArtifacts({ targetName, dist: current });

  prepareRuntimeDependencies({
    targetName,
    output: path.join(current, "node_modules"),
    cacheRoot: path.join(buildCache, "native-runtime"),
  });

  for (const name of ["start.sh", "start.bat"]) {
    copy(path.join(root, "launcher", name), path.join(deployment, name));
  }
  copy(path.join(dist, "launcher.js"), path.join(deployment, "launcher.js"));

  createZip(current, deployZip);
  createZip(deployment, bootstrapZip);

  console.log(`Target:    ${targetName}`);
  console.log(`Cache:     ${buildCache}`);
  console.log(`Bootstrap: ${bootstrapZip}`);
  console.log(`Upload:    ${deployZip}`);
}

try {
  const targetName = parseTargetArgument(process.argv.slice(2));
  build(targetName);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
