export interface RuntimeAsset {
  url: string;
  size: number;
}

export interface RuntimeManifest {
  buildId: string;
  bundle: RuntimeAsset;
  shell: RuntimeAsset;
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (!value || typeof value !== "object") {
    throw new Error("runtime manifest is not an object");
  }
  const manifest = value as Partial<RuntimeManifest>;
  const validAsset = (asset: RuntimeAsset | undefined): asset is RuntimeAsset =>
    !!asset &&
    typeof asset.url === "string" &&
    asset.url.length > 0 &&
    Number.isSafeInteger(asset.size) &&
    asset.size >= 0;
  if (
    typeof manifest.buildId !== "string" ||
    !manifest.buildId ||
    !validAsset(manifest.bundle) ||
    !validAsset(manifest.shell)
  ) {
    throw new Error("runtime manifest is malformed");
  }
  return manifest as RuntimeManifest;
}
