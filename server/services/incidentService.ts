import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import {
  findIncidentByPublicId,
  insertIncident,
  listIncidentGroups,
  listIncidentsForGroup,
  type IncidentEnvironment,
} from "@/server/data/incidents";

const MAX_STACK_LENGTH = 32_000;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_CONTEXT_LENGTH = 16_000;
const MAX_RELATED_INCIDENTS = 32;

export class PublicError extends Error {
  constructor(
    readonly publicMessage: string,
    message = publicMessage,
    readonly diagnostic?: unknown,
  ) {
    super(message);
    this.name = "PublicError";
  }
}

export class ContractViolationError extends PublicError {
  constructor(message: string, diagnostic?: unknown) {
    super("请求或响应不符合协议", message, diagnostic);
    this.name = "ContractViolationError";
  }
}

type ErrorWithDiagnostics = Error & {
  cause?: unknown;
  suppressedErrors?: unknown[];
};

/** Keep cleanup diagnostics on the primary panic without replacing its stack. */
export function attachSuppressedError(
  primary: unknown,
  suppressed: unknown,
): void {
  if (!(primary instanceof Error)) {
    console.error(
      "[Incident] cleanup failed after non-Error panic",
      suppressed,
    );
    return;
  }
  const diagnostic = primary as ErrorWithDiagnostics;
  try {
    if (!Object.prototype.hasOwnProperty.call(diagnostic, "suppressedErrors")) {
      Object.defineProperty(diagnostic, "suppressedErrors", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: [],
      });
    }
    diagnostic.suppressedErrors!.push(suppressed);
  } catch {
    console.error("[Incident] could not attach cleanup failure", suppressed);
  }
}

function clipped(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : String(error));
}

function normalizeTopFrame(stack: string): string {
  const lines = stack
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const application = lines.find(
    (line, index) =>
      index > 0 &&
      !line.includes("node:internal") &&
      !line.includes("server/services/incidentService") &&
      !line.includes("server/protocol/errorCodec"),
  );
  return (application ?? lines[1] ?? lines[0] ?? "unknown")
    .replace(/file:\/\/[^ )]+\/server\//, "server/")
    .replace(/https?:\/\/[^/]+\//, "/");
}

function safeContext(value: Record<string, unknown> | undefined) {
  if (!value) return null;
  try {
    const seen = new WeakSet<object>();
    const encoded = JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof Error) {
        return {
          name: item.name,
          message: clipped(item.message, MAX_MESSAGE_LENGTH),
          stack: clipped(item.stack ?? "", MAX_STACK_LENGTH),
        };
      }
      if (typeof item === "bigint") return item.toString();
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    });
    if (encoded.length <= MAX_CONTEXT_LENGTH) {
      return JSON.parse(encoded) as Record<string, unknown>;
    }
    return { truncated: clipped(encoded, MAX_CONTEXT_LENGTH) };
  } catch {
    return { serialization: "failed" };
  }
}

function uniqueIncidentIds(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])]
    .filter((value) => /^I_[A-Za-z0-9_-]{22}$/.test(value))
    .slice(0, MAX_RELATED_INCIDENTS);
}

export class IncidentService {
  constructor(
    private readonly db: Database,
    private readonly serverBuildId: string,
  ) {}

  capture(input: {
    environment: IncidentEnvironment;
    buildId?: string;
    error: unknown;
    context?: Record<string, unknown>;
    relatedIncidentIds?: readonly string[];
  }): { incidentId: string; publicMessage: string } {
    const error = asError(input.error);
    const stack = clipped(
      error.stack ?? `${error.name}: ${error.message}`,
      MAX_STACK_LENGTH,
    );
    const topFrame = normalizeTopFrame(stack);
    const buildId = clipped(input.buildId || this.serverBuildId, 256);
    const fingerprint = crypto
      .createHash("sha256")
      .update(`${input.environment}\0${buildId}\0${topFrame}`)
      .digest("hex");
    const publicMessage =
      error instanceof PublicError
        ? clipped(error.publicMessage, 500)
        : "服务器无法完成请求";
    const diagnostics = error as ErrorWithDiagnostics;
    const context = safeContext({
      ...(input.context ?? {}),
      ...(diagnostics.cause !== undefined
        ? { error_cause: diagnostics.cause }
        : {}),
      ...(diagnostics.suppressedErrors?.length
        ? { suppressed_errors: diagnostics.suppressedErrors }
        : {}),
      ...(error instanceof PublicError && error.diagnostic !== undefined
        ? { diagnostic: error.diagnostic }
        : {}),
    });
    const stored = insertIncident(this.db, {
      environment: input.environment,
      buildId,
      fingerprint,
      topFrame,
      occurredAt: new Date().toISOString(),
      errorName: clipped(error.name, 200),
      message: clipped(error.message, MAX_MESSAGE_LENGTH),
      stack,
      context,
      relatedIncidentIds: uniqueIncidentIds(input.relatedIncidentIds),
      publicIdFor: (id) => this.publicId(id),
    });
    return { incidentId: stored.publicId, publicMessage };
  }

  list(input: {
    environment?: IncidentEnvironment;
    buildId?: string;
    offset?: number;
  }) {
    return listIncidentGroups(this.db, {
      environment: input.environment,
      buildId: input.buildId,
      offset: Math.max(0, input.offset ?? 0),
      limit: 100,
    });
  }

  details(groupId: number) {
    return listIncidentsForGroup(this.db, groupId).map((row) => ({
      ...row,
      context: row.context_json ? JSON.parse(row.context_json) : null,
      related_incident_ids: row.related_incident_ids_json
        ? JSON.parse(row.related_incident_ids_json)
        : [],
    }));
  }

  find(publicId: string) {
    return findIncidentByPublicId(this.db, publicId);
  }

  private publicId(id: number): string {
    const key = this.encryptionKey();
    const prefix = crypto
      .createHmac("sha256", key)
      .update("classapp-incident-id-v1")
      .digest()
      .subarray(0, 8);
    const clear = Buffer.alloc(16);
    prefix.copy(clear, 0);
    clear.writeBigUInt64BE(BigInt(id), 8);
    const cipher = crypto.createCipheriv("aes-256-ecb", key, null);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
    return `I_${encrypted
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "")}`;
  }

  private encryptionKey(): Buffer {
    const row = this.db
      .prepare("SELECT value FROM config WHERE key = 'incident_id_key'")
      .get() as { value: string } | undefined;
    if (row && /^[0-9a-f]{64}$/i.test(row.value)) {
      return Buffer.from(row.value, "hex");
    }
    const value = crypto.randomBytes(32);
    this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES ('incident_id_key', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(value.toString("hex"));
    return value;
  }
}

const services = new WeakMap<Database, Map<string, IncidentService>>();

export function createIncidentService(
  db: Database,
  buildId: string,
): IncidentService {
  let byBuild = services.get(db);
  if (!byBuild) {
    byBuild = new Map();
    services.set(db, byBuild);
  }
  let service = byBuild.get(buildId);
  if (!service) {
    service = new IncidentService(db, buildId);
    byBuild.set(buildId, service);
  }
  return service;
}

/** Record an error at a boundary that must continue servicing other work. */
export function recordContainedServerIncident(
  db: Database,
  buildId: string,
  error: unknown,
  context: Record<string, unknown>,
): string | null {
  try {
    return createIncidentService(db, buildId).capture({
      environment: "server",
      error,
      context,
    }).incidentId;
  } catch (captureError) {
    console.error("[Incident] contained capture failed", captureError);
    console.error("[Incident] original contained failure", error);
    return null;
  }
}
