export interface RuntimeAsset {
  url: string;
  size: number;
}

export interface RuntimeManifest {
  buildId: string;
  debugMenu: boolean;
  bundle: RuntimeAsset;
  shell: RuntimeAsset;
}
