import fs from "node:fs";
import path from "node:path";
import {
  originalPositionFor,
  TraceMap,
  type SourceMapInput,
} from "@jridgewell/trace-mapping";
import type { IncidentEnvironment } from "@/server/data/incidents";

interface SourceMapManifest {
  format: "classapp-source-maps-v1";
  buildId: string;
  maps: Record<IncidentEnvironment, string>;
}

export interface IncidentStackSymbolicator {
  symbolize(
    environment: IncidentEnvironment,
    buildId: string,
    stack: string,
  ): string;
}

const LOCATION =
  /((?:blob:|https?:\/\/|file:\/\/\/)[^()\s]+|(?:[A-Za-z]:)?[^()\s]+\.m?js):(\d+):(\d+)/g;

function safeSourceName(source: string): string {
  const normalized = source
    .replace(/\\/g, "/")
    .replace(/^file:\/\//, "")
    .replace(/^(?:\.\.\/|\.\/)+/, "");
  for (const root of ["client", "server", "shared", "launcher"] as const) {
    const marker = `/${root}/`;
    const index = normalized.lastIndexOf(marker);
    if (index >= 0) return normalized.slice(index + 1);
    if (normalized.startsWith(`${root}/`)) return normalized;
  }
  return path.posix.basename(normalized);
}

function belongsToBundle(
  environment: IncidentEnvironment,
  generatedFile: string,
): boolean {
  if (environment === "client") {
    return (
      generatedFile.startsWith("blob:") ||
      /\/app\/app\.js(?:\?|$)/.test(generatedFile)
    );
  }
  return /(?:^|[/\\])main\.mjs$/.test(generatedFile);
}

export class FileIncidentSourceMaps implements IncidentStackSymbolicator {
  private readonly maps = new Map<IncidentEnvironment, TraceMap>();
  private readonly buildId: string | null;

  constructor(appDir: string) {
    const directory = path.join(appDir, "server", "source-maps");
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
      ) as SourceMapManifest;
      if (manifest.format !== "classapp-source-maps-v1") {
        throw new Error("unsupported source map manifest");
      }
      this.buildId = manifest.buildId;
      for (const environment of ["client", "server"] as const) {
        const file = manifest.maps[environment];
        const resolved = path.resolve(directory, file);
        if (!resolved.startsWith(`${path.resolve(directory)}${path.sep}`)) {
          throw new Error("source map path escapes its private directory");
        }
        this.maps.set(
          environment,
          new TraceMap(fs.readFileSync(resolved, "utf8") as SourceMapInput),
        );
      }
    } catch (error) {
      this.buildId = null;
      this.maps.clear();
      if (process.env.NODE_ENV === "production") {
        console.error("[Incident] private source maps unavailable", error);
      }
    }
  }

  symbolize(
    environment: IncidentEnvironment,
    buildId: string,
    stack: string,
  ): string {
    if (buildId !== this.buildId) return stack;
    const map = this.maps.get(environment);
    if (!map) return stack;
    return stack
      .split("\n")
      .map((stackLine) => {
        let originalName: string | null = null;
        const symbolized = stackLine.replace(
          LOCATION,
          (
            location,
            generatedFile: string,
            lineText: string,
            columnText: string,
          ) => {
            if (!belongsToBundle(environment, generatedFile)) return location;
            const original = originalPositionFor(map, {
              line: Number(lineText),
              column: Math.max(0, Number(columnText) - 1),
            });
            if (
              !original.source ||
              original.line == null ||
              original.column == null
            ) {
              return location;
            }
            originalName = original.name;
            return `${safeSourceName(original.source)}:${original.line}:${original.column + 1}`;
          },
        );
        if (!originalName) return symbolized;
        return symbolized
          .replace(
            /^(\s*at\s+)(?:async\s+)?[^\s(]+(?=\s*\()/,
            `$1${originalName}`,
          )
          .replace(/^[^@\s]+(?=@)/, originalName);
      })
      .join("\n");
  }
}
