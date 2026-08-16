#!/usr/bin/env node
/**
 * Assemble pinned media third-party artifacts into a release `dist`.
 *
 * Normal builds are offline from the artifact's point of view: everything is
 * resolved from `.cache/media` and verified against the committed manifest.
 * yt-dlp/plugin artifacts download on cache miss; the POT server cache is
 * build-host prepared and the build fails with instructions when absent.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBuildCache } from "./build-cache.mjs";
import { projectRoot } from "../paths.mjs";

const root = projectRoot;
const manifestPath = path.join(root, "lib", "media", "artifacts-manifest.json");

export function mediaManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function ensureCache(cacheRoot, spec, cachePath) {
  const target = path.join(cacheRoot, cachePath);
  if (
    fs.existsSync(target) &&
    (!spec.sha256 || sha256(target) === spec.sha256)
  ) {
    console.log(`[media] cache hit: ${cachePath}`);
    return target;
  }
  if (!spec.url) {
    throw new Error(
      `[media] ${cachePath} is not cached and has no URL. Run: npm run media:update`,
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.download`;
  console.log(`[media] downloading ${spec.url}`);
  const result = spawnSync("curl", ["-L", "--fail", "-o", temporary, spec.url], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`curl failed: ${spec.url}`);
  if (spec.bytes && fs.statSync(temporary).size !== spec.bytes) {
    throw new Error(`[media] size mismatch: ${spec.url}`);
  }
  if (spec.sha256 && sha256(temporary) !== spec.sha256) {
    throw new Error(`[media] sha256 mismatch: ${spec.url}`);
  }
  fs.renameSync(temporary, target);
  return target;
}

function extract(zip, destination) {
  fs.mkdirSync(destination, { recursive: true });
  run("unzip", ["-q", zip, "-d", destination]);
}

function copyPotServerCache(cacheRoot, manifest, platform, destination) {
  const source = path.join(
    cacheRoot,
    manifest.potProvider.server.cache,
    platform,
  );
  if (!fs.existsSync(path.join(source, "main.js"))) {
    throw new Error(
      `[media] POT server cache missing for ${platform} at ${source}. ` +
        "Run `npm run media:update` on a build host for that platform.",
    );
  }
  fs.cpSync(source, destination, { recursive: true });
}

export function assembleMediaArtifacts({ targetName, dist }) {
  const manifest = mediaManifest();
  const cacheRoot = path.join(resolveBuildCache(), "media");
  const destination = path.join(dist, "server", "media");
  fs.mkdirSync(destination, { recursive: true });
  const platform = targetName === "windows" ? "windows" : "linux";

  if (platform === "windows") {
    const zip = ensureCache(
      cacheRoot,
      manifest.ytDlp.windows,
      `yt-dlp/${manifest.ytDlp.version}/yt-dlp_win.zip`,
    );
    const extractRoot = path.join(cacheRoot, `yt-dlp/windows-extract-${manifest.ytDlp.version}`);
    fs.rmSync(extractRoot, { recursive: true, force: true });
    extract(zip, extractRoot);
    for (const entry of ["yt-dlp.exe", "_internal"]) {
      const source = path.join(extractRoot, entry);
      if (!fs.existsSync(source)) throw new Error(`Missing ${entry} in yt-dlp zip`);
      fs.cpSync(source, path.join(destination, entry), { recursive: true });
    }
  } else {
    const binary = ensureCache(
      cacheRoot,
      manifest.ytDlp.linux,
      `yt-dlp/${manifest.ytDlp.version}/yt-dlp_linux`,
    );
    const target = path.join(destination, "yt-dlp_linux");
    fs.copyFileSync(binary, target);
    fs.chmodSync(target, 0o755);
  }

  const pluginZip = ensureCache(
    cacheRoot,
    manifest.potProvider.plugin,
    `pot-plugin/${manifest.potProvider.sourceRef.replace(/^tag\s+/, "")}.zip`,
  );
  const pluginStaging = path.join(cacheRoot, `pot-plugin/extract-${manifest.potProvider.sourceRef.replace(/^tag\s+/, "")}`);
  fs.rmSync(pluginStaging, { recursive: true, force: true });
  extract(pluginZip, pluginStaging);
  // --plugin-dirs expects a directory containing plugin package folders, each
  // with its own yt_dlp_plugins namespace folder.
  const pluginDestination = path.join(destination, "pot-plugin");
  const pluginPackage = path.join(pluginDestination, "bgutil-ytdlp-pot-provider");
  fs.rmSync(pluginDestination, { recursive: true, force: true });
  fs.mkdirSync(pluginPackage, { recursive: true });
  fs.cpSync(
    path.join(pluginStaging, "yt_dlp_plugins"),
    path.join(pluginPackage, "yt_dlp_plugins"),
    { recursive: true },
  );

  // ClassApp's own extractor plugin lives in the same plugin root so one
  // --plugin-dirs argument loads both the POT provider and the fast music
  // search entry parser.
  const classappPluginSource = path.join(
    root,
    "lib",
    "media",
    "ytdlp-plugins",
    "classapp-music-search",
  );
  if (!fs.existsSync(classappPluginSource)) {
    throw new Error(`Missing classapp media plugin at ${classappPluginSource}`);
  }
  fs.cpSync(
    classappPluginSource,
    path.join(pluginDestination, "classapp-music-search"),
    { recursive: true },
  );

  copyPotServerCache(cacheRoot, manifest, platform, path.join(destination, "pot-server"));

  fs.writeFileSync(
    path.join(destination, "THIRD-PARTY-NOTICES.md"),
    `# Media third-party notices\n\n` +
      `- yt-dlp ${manifest.ytDlp.version} — Unlicense — https://github.com/yt-dlp/yt-dlp\n` +
      `- bgutil-ytdlp-pot-provider ${manifest.potProvider.sourceRef} — ${manifest.potProvider.license} — ` +
      `https://github.com/Brainicism/bgutil-ytdlp-pot-provider\n` +
      `\nThe POT provider runs as a separate process behind an HTTP boundary. Its license and corresponding source notice apply to that component.\n`,
  );
  console.log(`[media] assembled ${platform} artifacts into ${destination}`);
}
