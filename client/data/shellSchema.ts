export const SHELL_STORES = {
  BUNDLES: "shell_bundles",
  KV: "shell_kv",
} as const;

export const SHELL_KEYS = {
  ACTIVE_BUNDLE: "active-bundle",
  SCHEMA_VERSION: "schema-version",
} as const;

export type ShellStoreName = (typeof SHELL_STORES)[keyof typeof SHELL_STORES];
