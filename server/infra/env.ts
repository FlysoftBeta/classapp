import { getRuntimeConfig } from "@/server/infra/runtimeConfig";

const runtime = getRuntimeConfig();

export const BUILD_ID = runtime.buildId;
export const DATA_ROOT = runtime.dataRoot;
export const APP_DIR = runtime.appDir;
export const PORTS = runtime.ports;
