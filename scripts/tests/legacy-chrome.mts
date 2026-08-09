import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveBuildCache } from "../builds/build-cache.mjs";
import { worktreePath } from "../paths.mjs";

const DEB = worktreePath("chrome.deb");
const EXPECTED_SHA256 =
  "d7f8866b202deb82cbeffa2d66b26ad8f59dafed24aa0422e166541e5a724c20";
const EXPECTED_VERSION = "Google Chrome 70.0.3538.77";
const CACHE_PARENT = path.join(resolveBuildCache(), "chrome70");
const CACHE_ROOT = path.join(CACHE_PARENT, `chrome70-${EXPECTED_SHA256}`);
const CACHED_EXECUTABLE = path.join(
  CACHE_ROOT,
  "opt",
  "google",
  "chrome",
  "google-chrome",
);

export type Chrome70 = {
  executable: string;
  version: string;
};

type LaunchChrome70Options = {
  userDataDir: string;
  url: string;
  headless?: boolean;
  hostResolverRules?: string[];
  remoteDebugging?: boolean;
};

function readChromeVersion(executable: string): string | null {
  const version = spawnSync(executable, ["--version"], {
    encoding: "utf8",
  });
  if (version.error || version.status !== 0) return null;
  return version.stdout.trim();
}

export async function prepareChrome70(): Promise<Chrome70> {
  if (readChromeVersion(CACHED_EXECUTABLE) === EXPECTED_VERSION) {
    return { executable: CACHED_EXECUTABLE, version: EXPECTED_VERSION };
  }

  const digest = createHash("sha256")
    .update(await readFile(DEB))
    .digest("hex");
  if (digest !== EXPECTED_SHA256) {
    throw new Error(`Chrome 70 package hash mismatch: ${digest}`);
  }

  await mkdir(CACHE_PARENT, { recursive: true });
  const extractionRoot = await mkdtemp(
    path.join(CACHE_PARENT, "chrome70-extract-"),
  );
  const debParts = path.join(extractionRoot, "deb");
  const extracted = path.join(extractionRoot, "chrome");

  try {
    await Promise.all([mkdir(debParts), mkdir(extracted)]);
    const unpackDeb = spawnSync("/usr/bin/ar", ["x", DEB, "data.tar.xz"], {
      encoding: "utf8",
      cwd: debParts,
    });
    if (unpackDeb.error) throw unpackDeb.error;
    if (unpackDeb.status !== 0) {
      throw new Error(unpackDeb.stderr || "Could not unpack Chrome package");
    }

    const extraction = spawnSync(
      "/usr/bin/tar",
      ["-xJf", path.join(debParts, "data.tar.xz"), "-C", extracted],
      { encoding: "utf8" },
    );
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0) {
      throw new Error(extraction.stderr || "Could not extract Chrome payload");
    }

    const executable = path.join(
      extracted,
      "opt",
      "google",
      "chrome",
      "google-chrome",
    );
    await access(executable);
    const version = readChromeVersion(executable);
    if (version !== EXPECTED_VERSION) {
      throw new Error(`Unexpected Chrome version: ${version ?? "unknown"}`);
    }

    await rm(CACHE_ROOT, { recursive: true, force: true });
    await rename(extracted, CACHE_ROOT);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }

  return { executable: CACHED_EXECUTABLE, version: EXPECTED_VERSION };
}

export function launchChrome70(
  chrome: Chrome70,
  options: LaunchChrome70Options,
): ChildProcess {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-nacl",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--disable-background-networking",
    "--enable-gpu-rasterization",
    "--enable-oop-rasterization",
    "--enable-features=VizDisplayCompositor,UseSkiaRenderer",
    "--enable-blink-features=MiddleClickAutoscroll", // QOL for massive scrolling tests
    "--password-store=basic",
    `--user-data-dir=${options.userDataDir}`,
  ];
  if (options.headless) args.push("--headless", "--disable-gpu");
  if (options.hostResolverRules?.length) {
    args.push(
      `--host-resolver-rules=${[
        ...options.hostResolverRules,
        "EXCLUDE localhost",
      ].join(",")}`,
    );
  }
  if (options.remoteDebugging) args.push("--remote-debugging-port=0");
  args.push(options.url);

  return spawn(chrome.executable, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
    env: {
      ...process.env,
      GDK_BACKEND: "x11",
    },
  });
}
