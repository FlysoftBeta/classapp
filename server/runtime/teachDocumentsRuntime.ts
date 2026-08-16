import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import type BetterSqlite3 from "better-sqlite3";
import {
  deleteTeachDocuments,
  findTeachDocumentByObjectKey,
  insertTeachDocument,
  listCapturingTeachDocuments,
  publishTeachDocument,
  reconcileTeachDocumentQuotaItems,
  type TeachDocumentType,
} from "@/server/data/teachDocuments";
import { ObjectStore } from "@/server/storage/objectStore";
import { QuotaService } from "@/server/storage/quotaService";
import {
  PublicError,
  recordContainedServerIncident,
} from "@/server/services/incidentService";
import { BUILD_ID } from "@/server/infra/env";

export interface OpenOfficeDocument {
  application: string;
  documentType: TeachDocumentType;
  name: string;
  path: string;
}

export const TEACH_DOCUMENTS_QUOTA_GROUP = "teach-documents";

const POLL_INTERVAL_MS = 2_000;
const RETENTION_DAYS = 7;
const TARGET_RATIO = 0.8;

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

/**
 * Process-lifetime teaching-document mechanisms: quota policy/ledger
 * reconciliation, owner eviction, and the Windows Office/WPS monitor child.
 * Never captures Scope or Actor; request paths get a Service.
 */
export class TeachDocumentsRuntime {
  private readonly quota = new QuotaService(this.db);
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = true;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private capturedOpenPaths = new Set<string>();
  private pending = Promise.resolve();
  private started = false;

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly objects: ObjectStore,
  ) {}

  get monitorAvailable(): boolean {
    return process.platform === "win32";
  }

  quotaPolicy() {
    return {
      name: TEACH_DOCUMENTS_QUOTA_GROUP,
      maxBytes: 0,
      targetRatio: TARGET_RATIO,
      minAgeMs: RETENTION_DAYS * 24 * 60 * 60_000,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.quota.configure(this.quotaPolicy());
    this.reconcileQuotaItems();
    void this.reconcileCapturing();
    this.stopped = false;
    this.launchMonitor();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill();
    this.child = null;
  }

  async capture(document: OpenOfficeDocument): Promise<void> {
    const source = await stat(document.path);
    if (!source.isFile()) throw new PublicError("源文档不是文件");
    const id = crypto.randomUUID();
    const ref = this.objects.ref(TEACH_DOCUMENTS_QUOTA_GROUP, id);
    // Durable intent first: a crash between the row and the object is
    // compensated on the next start by reconcileCapturing.
    insertTeachDocument(this.db, {
      id,
      application: document.application,
      document_type: document.documentType,
      name: document.name,
      object_key: id,
      file_size: source.size,
      status: "capturing",
    });
    try {
      const stored = await this.objects.copyBlob(ref, document.path, {
        expectedBytes: source.size,
      });
      const after = await stat(document.path);
      if (
        !after.isFile() ||
        after.size !== source.size ||
        after.mtimeMs !== source.mtimeMs
      ) {
        throw new PublicError("源文档在复制期间发生变化，请稍后重试");
      }
      publishTeachDocument(this.db, id, stored.bytes);
      this.quota.upsert(TEACH_DOCUMENTS_QUOTA_GROUP, id, stored.bytes);
    } catch (error) {
      deleteTeachDocuments(this.db, [id]);
      this.quota.remove(TEACH_DOCUMENTS_QUOTA_GROUP, id);
      try {
        await this.objects.trash(ref);
      } catch (cleanupError) {
        recordContainedServerIncident(this.db, BUILD_ID, cleanupError, {
          component: "teach-documents",
          phase: "rollback-capture",
          original_error:
            error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /** Owner evictor registered with the shared storage quota service. */
  async evict(objectKey: string): Promise<boolean> {
    const document = findTeachDocumentByObjectKey(this.db, objectKey);
    if (!document) return false;
    return this.removeOne(document);
  }

  private async removeOne(document: {
    id: string;
    object_key: string;
  }): Promise<boolean> {
    // The SQLite row is authority; delete it before the materialized bytes.
    deleteTeachDocuments(this.db, [document.id]);
    this.quota.remove(TEACH_DOCUMENTS_QUOTA_GROUP, document.id);
    try {
      await this.objects.trash(
        this.objects.ref(TEACH_DOCUMENTS_QUOTA_GROUP, document.object_key),
      );
      return true;
    } catch (error) {
      recordContainedServerIncident(this.db, BUILD_ID, error, {
        component: "teach-documents",
        phase: "cleanup",
        object_key: document.object_key,
      });
      return false;
    }
  }

  /** Backfill quota rows with one SQL upsert-seed, never a Node-side scan. */
  private reconcileQuotaItems(): void {
    reconcileTeachDocumentQuotaItems(this.db);
  }

  /** Compensation for captures interrupted before they reached ready. */
  private async reconcileCapturing(): Promise<void> {
    for (const document of listCapturingTeachDocuments(this.db)) {
      try {
        await this.objects.trash(
          this.objects.ref(TEACH_DOCUMENTS_QUOTA_GROUP, document.object_key),
        );
      } catch (error) {
        recordContainedServerIncident(this.db, BUILD_ID, error, {
          component: "teach-documents",
          phase: "reconcile-capturing",
          object_key: document.object_key,
        });
      }
      deleteTeachDocuments(this.db, [document.id]);
      this.quota.remove(TEACH_DOCUMENTS_QUOTA_GROUP, document.id);
    }
  }

  private handleSnapshot = async (
    documents: OpenOfficeDocument[],
  ): Promise<void> => {
    const unique = new Map<string, OpenOfficeDocument>();
    for (const document of documents) {
      unique.set(document.path.toLocaleLowerCase("en-US"), document);
    }
    const nextCaptured = new Set<string>();
    for (const [key, document] of unique) {
      if (this.capturedOpenPaths.has(key)) {
        nextCaptured.add(key);
        continue;
      }
      try {
        await this.capture(document);
        nextCaptured.add(key);
      } catch (error) {
        recordContainedServerIncident(this.db, BUILD_ID, error, {
          component: "office-document-monitor",
          phase: "capture",
          path: document.path,
        });
      }
    }
    this.capturedOpenPaths = nextCaptured;
  };

  private launchMonitor(): void {
    if (this.stopped || process.platform !== "win32") return;
    const child = spawn(
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
    this.child = child;
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
          this.pending = this.pending.then(() =>
            this.handleSnapshot(documents),
          );
        } catch (error) {
          recordContainedServerIncident(this.db, BUILD_ID, error, {
            component: "office-document-monitor",
            phase: "parse-output",
          });
        }
      }
    });
    child.on("error", (error) => {
      recordContainedServerIncident(this.db, BUILD_ID, error, {
        component: "office-document-monitor",
        phase: "process",
      });
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.stopped) {
        this.restartTimer = setTimeout(() => this.launchMonitor(), 5_000);
        this.restartTimer.unref();
      }
    });
  }
}
