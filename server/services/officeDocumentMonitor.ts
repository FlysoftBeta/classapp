import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type BetterSqlite3 from "better-sqlite3";
import {
  createTeachDocumentsService,
  type OpenOfficeDocument,
} from "@/server/services/teachDocumentsService";
import { recordContainedServerIncident } from "@/server/services/incidentService";
import { BUILD_ID } from "@/server/infra/env";

const POLL_INTERVAL_MS = 2_000;

const POWERSHELL_SCRIPT = String.raw`
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$targets = @(
  @{ application = "Microsoft Word"; id = "Word.Application"; type = "word"; collection = "Documents" },
  @{ application = "WPS 文字"; id = "KWPS.Application"; type = "word"; collection = "Documents" },
  @{ application = "Microsoft PowerPoint"; id = "PowerPoint.Application"; type = "powerpoint"; collection = "Presentations" },
  @{ application = "WPS 演示"; id = "KWPP.Application"; type = "powerpoint"; collection = "Presentations" },
  @{ application = "Microsoft Excel"; id = "Excel.Application"; type = "excel"; collection = "Workbooks" },
  @{ application = "WPS 表格"; id = "KET.Application"; type = "excel"; collection = "Workbooks" }
)

while ($true) {
  $documents = @()
  foreach ($target in $targets) {
    try {
      $app = [Runtime.InteropServices.Marshal]::GetActiveObject($target.id)
      $items = $app.($target.collection)
      for ($index = 1; $index -le $items.Count; $index++) {
        try {
          $document = $items.Item($index)
          $directory = [string]$document.Path
          if ($directory) {
            $fullName = [string]$document.FullName
            $documents += @{
              application = $target.application
              documentType = $target.type
              name = [string]$document.Name
              path = $fullName
            }
          }
        } catch {
        }
      }
    } catch {
    }
  }
  ConvertTo-Json -InputObject @($documents) -Compress
  Start-Sleep -Milliseconds ${POLL_INTERVAL_MS}
}
`;

function isOpenOfficeDocument(value: unknown): value is OpenOfficeDocument {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<OpenOfficeDocument>;
  return (
    typeof item.application === "string" &&
    (item.documentType === "word" ||
      item.documentType === "powerpoint" ||
      item.documentType === "excel") &&
    typeof item.name === "string" &&
    typeof item.path === "string" &&
    item.path.length > 0
  );
}

export function startOfficeDocumentMonitor(
  db: BetterSqlite3.Database,
): () => void {
  if (process.platform !== "win32") {
    return () => undefined;
  }

  const service = createTeachDocumentsService(db);
  let child: ChildProcessWithoutNullStreams | null = null;
  let stopped = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let capturedOpenPaths = new Set<string>();
  let pending = Promise.resolve();

  const handleSnapshot = async (documents: OpenOfficeDocument[]) => {
    const unique = new Map<string, OpenOfficeDocument>();
    for (const document of documents) {
      unique.set(document.path.toLocaleLowerCase("en-US"), document);
    }
    const nextCaptured = new Set<string>();
    for (const [key, document] of unique) {
      if (capturedOpenPaths.has(key)) {
        nextCaptured.add(key);
        continue;
      }
      try {
        await service.capture(document);
        nextCaptured.add(key);
      } catch (error) {
        recordContainedServerIncident(db, BUILD_ID, error, {
          component: "office-document-monitor",
          phase: "capture",
          path: document.path,
        });
      }
    }
    capturedOpenPaths = nextCaptured;
  };

  const launch = () => {
    if (stopped) return;
    child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        POWERSHELL_SCRIPT,
      ],
      { windowsHide: true },
    );
    child.stdin.end();
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) console.error(`[OfficeMonitor] ${message}`);
    });

    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const value: unknown = JSON.parse(line);
          const documents = Array.isArray(value)
            ? value.filter(isOpenOfficeDocument)
            : [];
          pending = pending.then(() => handleSnapshot(documents));
        } catch (error) {
          recordContainedServerIncident(db, BUILD_ID, error, {
            component: "office-document-monitor",
            phase: "parse-output",
          });
        }
      }
    });
    child.on("error", (error) => {
      recordContainedServerIncident(db, BUILD_ID, error, {
        component: "office-document-monitor",
        phase: "process",
      });
    });
    child.on("exit", () => {
      child = null;
      if (!stopped) {
        restartTimer = setTimeout(launch, 5_000);
        restartTimer.unref();
      }
    });
  };

  launch();
  return () => {
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    child?.kill();
    child = null;
  };
}
