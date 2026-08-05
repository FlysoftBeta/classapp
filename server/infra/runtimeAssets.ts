import fs from "node:fs";
import path from "node:path";
import type { ClassAppRuntimeConfig } from "./runtimeConfig";
import type { RuntimeManifest } from "@/shared/runtimeManifest";

export interface RuntimeAssets {
  shellFile: string;
  bundleFile: string;
}

export function runtimeAssets(appDir: string): RuntimeAssets {
  return {
    shellFile: path.join(appDir, "shell.html"),
    bundleFile: path.join(appDir, "client", "app", "app.js"),
  };
}

export function createRuntimeManifest(
  config: ClassAppRuntimeConfig,
): RuntimeManifest {
  const assets = runtimeAssets(config.appDir);
  const version = encodeURIComponent(config.buildId);
  return {
    buildId: config.buildId,
    bundle: {
      url: `/app/app.js?v=${version}`,
      size: fs.existsSync(assets.bundleFile)
        ? fs.statSync(assets.bundleFile).size
        : 0,
    },
    shell: {
      url: `/app/shell.html?v=${version}`,
      size: fs.existsSync(assets.shellFile)
        ? fs.statSync(assets.shellFile).size
        : 0,
    },
  };
}
