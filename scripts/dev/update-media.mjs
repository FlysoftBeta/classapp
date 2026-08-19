#!/usr/bin/env node
/**
 * Refresh `lib/media/artifacts-manifest.json` and prepare the POT server cache.
 *
 * This is the only media path allowed to touch npm/git/network. Normal release
 * builds only verify the committed manifest against `.cache/media`.
 * `--prepare-cache` fills that cache from the committed pins without rewriting
 * the manifest; CI uses it so a Windows assembly does not bump yt-dlp/POT.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { unzipSync } from "fflate";
import { resolveBuildCache } from "../builds/build-cache.mjs";
import { projectRoot } from "../paths.mjs";

const root = projectRoot;
const manifestPath = path.join(root, "lib", "media", "artifacts-manifest.json");
const potRepository = "https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function runJson(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return JSON.parse(result.stdout.trim());
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseArgs(argv) {
  let ytDlpVersion = null;
  let potTag = null;
  let buildPot = true;
  let prepareCache = false;
  let platform = process.platform === "win32" ? "windows" : "linux";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yt-dlp" && argv[index + 1]) ytDlpVersion = argv[++index];
    else if (arg.startsWith("--yt-dlp=")) ytDlpVersion = arg.slice("--yt-dlp=".length);
    else if (arg === "--pot" && argv[index + 1]) potTag = argv[++index];
    else if (arg.startsWith("--pot=")) potTag = arg.slice("--pot=".length);
    else if (arg === "--platform" && argv[index + 1]) platform = argv[++index];
    else if (arg.startsWith("--platform=")) platform = arg.slice("--platform=".length);
    else if (arg === "--no-pot-build") buildPot = false;
    else if (arg === "--prepare-cache") prepareCache = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (platform !== "linux" && platform !== "windows") {
    throw new Error("--platform must be linux or windows");
  }
  if (prepareCache && (ytDlpVersion || potTag)) {
    throw new Error("--prepare-cache cannot be combined with --yt-dlp or --pot");
  }
  return { ytDlpVersion, potTag, buildPot, prepareCache, platform };
}

function ytDlpRelease(version) {
  const release = runJson("curl", [
    "-L",
    "--fail",
    "-s",
    version
      ? `https://api.github.com/repos/yt-dlp/yt-dlp/releases/tags/${version}`
      : "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
  ]);
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  const sumsAsset = assets.get("SHA2-256SUMS");
  if (!sumsAsset) throw new Error("yt-dlp release is missing SHA2-256SUMS");
  const result = spawnSync("curl", ["-L", "--fail", "-s", sumsAsset.browser_download_url], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("failed to download SHA2-256SUMS");
  const sums = new Map(
    result.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length === 2)
      .map(([hash, name]) => [name.replace(/^\*/, ""), hash]),
  );
  const linux = assets.get("yt-dlp_linux");
  const windows = assets.get("yt-dlp_win.zip");
  if (!linux || !windows) throw new Error("release assets missing");
  return {
    version: release.tag_name,
    linux: {
      url: linux.browser_download_url,
      sha256: sums.get("yt-dlp_linux"),
      bytes: linux.size,
    },
    windows: {
      url: windows.browser_download_url,
      sha256: sums.get("yt-dlp_win.zip"),
      bytes: windows.size,
    },
  };
}

function potRelease(tag) {
  const url = tag
    ? `https://api.github.com/repos/Brainicism/bgutil-ytdlp-pot-provider/releases/tags/${tag}`
    : "https://api.github.com/repos/Brainicism/bgutil-ytdlp-pot-provider/releases/latest";
  const release = runJson("curl", ["-L", "--fail", "-s", url]);
  const plugin = release.assets.find((asset) => asset.name.endsWith(".zip"));
  if (!plugin) throw new Error("pot release is missing plugin zip");
  return { tag: release.tag_name, url: plugin.browser_download_url, bytes: plugin.size };
}

function buildPotServer(tag, platform) {
  const cacheRoot = path.join(resolveBuildCache(), "media", "pot-server", tag);
  const source = path.join(cacheRoot, "src");
  const sourceExists = fs.existsSync(path.join(source, "server", "build", "main.js"));
  if (!sourceExists) {
    fs.rmSync(source, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(source), { recursive: true });
    run("git", ["clone", "--single-branch", "--branch", tag, potRepository, source]);
  }
  const serverSource = path.join(source, "server");
  if (!sourceExists) {
    run("npm", ["ci"], { cwd: serverSource });
    run("npx", ["tsc"], { cwd: serverSource });
  }

  const destination = path.join(cacheRoot, platform);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(path.join(serverSource, "build"), destination, { recursive: true });

  if (platform === "linux" || process.platform === "win32") {
    fs.cpSync(path.join(serverSource, "node_modules"), path.join(destination, "node_modules"), {
      recursive: true,
    });
  } else {
    // Windows artifacts can be prepared on Linux by asking npm for the win32
    // canvas prebuild tree; the compiled JS in build/ is platform-independent.
    const winSource = path.join(cacheRoot, "win-src");
    fs.rmSync(winSource, { recursive: true, force: true });
    fs.cpSync(source, winSource, { recursive: true });
    run("npm", ["ci", "--omit=dev"], {
      cwd: path.join(winSource, "server"),
      env: {
        ...process.env,
        npm_config_platform: "win32",
        npm_config_arch: "x64",
      },
    });
    fs.cpSync(
      path.join(winSource, "server", "node_modules"),
      path.join(destination, "node_modules"),
      { recursive: true },
    );
  }
  fs.cpSync(path.join(serverSource, "package.json"), path.join(destination, "package.json"));
  if (!fs.existsSync(path.join(destination, "main.js"))) {
    throw new Error("POT server build did not produce build/main.js");
  }
  console.log(`[media] POT server prepared for ${platform}: ${destination}`);
}

function downloadForHash(url, file) {
  run("curl", ["-L", "--fail", "-o", file, url]);
  return sha256(file);
}

function cacheVerified(spec, relativePath) {
  const target = path.join(resolveBuildCache(), "media", relativePath);
  if (fs.existsSync(target) && sha256(target) === spec.sha256) {
    console.log(`[media] cache hit: ${relativePath}`);
    return target;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.download`;
  run("curl", ["-L", "--fail", "-o", temporary, spec.url]);
  if (spec.bytes && fs.statSync(temporary).size !== spec.bytes) {
    throw new Error(`[media] size mismatch for ${spec.url}`);
  }
  if (sha256(temporary) !== spec.sha256) {
    throw new Error(`[media] sha256 mismatch for ${spec.url}`);
  }
  fs.renameSync(temporary, target);
  console.log(`[media] cached: ${relativePath}`);
  return target;
}

function cacheYtDlp(manifest) {
  const cacheRoot = path.join(resolveBuildCache(), "media");
  const linux = cacheVerified(
    manifest.ytDlp.linux,
    `yt-dlp/${manifest.ytDlp.version}/yt-dlp_linux`,
  );
  fs.chmodSync(linux, 0o755);
  const windowsZip = cacheVerified(
    manifest.ytDlp.windows,
    `yt-dlp/${manifest.ytDlp.version}/yt-dlp_win.zip`,
  );
  const extractRoot = path.join(
    cacheRoot,
    "yt-dlp",
    `windows-extract-${manifest.ytDlp.version}`,
  );
  if (!fs.existsSync(path.join(extractRoot, "yt-dlp.exe"))) {
    fs.rmSync(extractRoot, { recursive: true, force: true });
    const archive = unzipSync(new Uint8Array(fs.readFileSync(windowsZip)));
    for (const [name, bytes] of Object.entries(archive)) {
      const target = path.join(extractRoot, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!name.endsWith("/")) fs.writeFileSync(target, bytes);
    }
  }
  console.log(`[media] yt-dlp ${manifest.ytDlp.version} cached for both platforms`);
}

function cachePlugin(manifest) {
  const tag = manifest.potProvider.sourceRef.replace(/^tag\s+/, "");
  const zip = cacheVerified(
    manifest.potProvider.plugin,
    `pot-plugin/${tag}.zip`,
  );
  const extractRoot = path.join(resolveBuildCache(), "media", "pot-plugin", `extract-${tag}`);
  if (!fs.existsSync(path.join(extractRoot, "yt_dlp_plugins", "extractor"))) {
    fs.rmSync(extractRoot, { recursive: true, force: true });
    const archive = unzipSync(new Uint8Array(fs.readFileSync(zip)));
    for (const [name, bytes] of Object.entries(archive)) {
      const target = path.join(extractRoot, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!name.endsWith("/")) fs.writeFileSync(target, bytes);
    }
  }
  console.log(`[media] POT plugin ${tag} cached`);
}

function populateCache(manifest, { platform, buildPot }) {
  cacheYtDlp(manifest);
  cachePlugin(manifest);
  if (buildPot) {
    buildPotServer(
      manifest.potProvider.sourceRef.replace(/^tag\s+/, ""),
      platform,
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (args.prepareCache) {
    populateCache(manifest, args);
    console.log("[media] cache prepared from committed manifest");
    return;
  }
  if (args.ytDlpVersion || manifest.ytDlp.version !== args.ytDlpVersion) {
    const ytDlp = ytDlpRelease(args.ytDlpVersion ?? null);
    for (const value of [ytDlp.linux, ytDlp.windows]) {
      if (!value.sha256) throw new Error("missing yt-dlp checksum");
    }
    manifest.ytDlp = ytDlp;
  }
  if (args.potTag || !manifest.potProvider.plugin.sha256) {
    const release = potRelease(args.potTag ?? manifest.potProvider.sourceRef.replace(/^tag\s+/, ""));
    const temporary = path.join(resolveBuildCache(), "media", "pot-plugin-refresh.zip");
    fs.mkdirSync(path.dirname(temporary), { recursive: true });
    manifest.potProvider.sourceRef = `tag ${release.tag}`;
    manifest.potProvider.plugin = {
      url: release.url,
      sha256: downloadForHash(release.url, temporary),
      bytes: release.bytes,
    };
  }
  populateCache(manifest, args);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[media] manifest updated: ${manifestPath}`);
  if (args.buildPot) {
    console.log(
      "[media] Prepare the other POT server platform with --platform <other>.",
    );
  }
}

main();
