export const BUILD_TARGETS = Object.freeze({
  "linux-redhat": Object.freeze({
    runtimePlatform: "linux",
    rendererSource: "lib/poppler-prebuilt/linux-redhat",
    rendererDestination: "linux",
  }),
  "linux-debian": Object.freeze({
    runtimePlatform: "linux",
    rendererSource: "lib/poppler-prebuilt/linux-debian",
    rendererDestination: "linux",
  }),
  windows: Object.freeze({
    runtimePlatform: "windows",
    rendererSource: "lib/poppler-prebuilt/windows",
    rendererDestination: "windows",
  }),
});

export const BUILD_TARGET_NAMES = Object.freeze(Object.keys(BUILD_TARGETS));

export function resolveBuildTarget(name) {
  const target = BUILD_TARGETS[name];
  if (!target) {
    throw new Error(
      `Unsupported build target ${JSON.stringify(name)}. Expected one of: ${BUILD_TARGET_NAMES.join(", ")}`,
    );
  }
  return target;
}
