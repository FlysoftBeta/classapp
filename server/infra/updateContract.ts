/** Shared contract between the server-side update service and launcher. */
export const UPDATE_CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;

export const REQUIRED_DEPLOY_ENTRIES = [
  "client",
  "server",
  "shell.html",
  "server.js",
  "build-id.txt",
  "node_modules",
] as const;
