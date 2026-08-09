import path from "node:path";
import { projectRoot } from "../paths.mjs";

export function resolveBuildCache() {
  const configured = process.env.CLASSAPP_BUILD_CACHE;
  return configured
    ? path.resolve(projectRoot, configured)
    : path.join(projectRoot, ".cache");
}
