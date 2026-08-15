import type { Database } from "better-sqlite3";
import {
  listIncidentLogsForBuild,
  type IncidentLogRow,
} from "@/server/data/incidents";
import { zipFiles } from "@/server/infra/archive";
import { PublicError } from "@/server/services/incidentService";

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { malformed_json: value };
  }
}

function serializeLog(row: IncidentLogRow): string {
  return JSON.stringify({
    incident_id: row.public_id,
    environment: row.environment,
    build_id: row.build_id,
    occurred_at: row.occurred_at,
    error: {
      name: row.error_name,
      message: row.message,
      stack: row.stack,
    },
    context: parseJson(row.context_json),
    related_incident_ids: parseJson(row.related_incident_ids_json) ?? [],
    group: {
      id: row.group_id,
      fingerprint: row.fingerprint,
      top_frame: row.top_frame,
      occurrence_count: row.occurrence_count,
      stored_detail_count: row.stored_detail_count,
      first_at: row.first_at,
      last_at: row.last_at,
    },
  });
}

function archiveFileName(buildId: string): string {
  const safeBuildId = buildId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100);
  return `incident-logs-${safeBuildId || "unknown"}.zip`;
}

type EventCategory = {
  file: string;
  environment: IncidentLogRow["environment"];
  fingerprint: string;
  top_frame: string;
  occurrence_count: number;
  stored_detail_count: number;
  archived_occurrence_count: number;
  first_at: string;
  last_at: string;
};

/** Export the current build only, placing every Incident event group in its own file. */
export function buildIncidentLogArchive(
  db: Database,
  buildId: string,
): { zipName: string; zipData: Uint8Array } {
  try {
    const rows = listIncidentLogsForBuild(db, buildId);
    const files: Record<string, Uint8Array> = {};
    const grouped = new Map<number, IncidentLogRow[]>();

    for (const row of rows) {
      const category = grouped.get(row.group_id);
      if (category) category.push(row);
      else grouped.set(row.group_id, [row]);
    }

    const eventCategories: EventCategory[] = [];
    for (const categoryRows of grouped.values()) {
      const [category] = categoryRows;
      const file = `events/${category.fingerprint}.jsonl`;
      const body = `${categoryRows.map(serializeLog).join("\n")}\n`;
      files[file] = Buffer.from(body, "utf8");
      eventCategories.push({
        file,
        environment: category.environment,
        fingerprint: category.fingerprint,
        top_frame: category.top_frame,
        occurrence_count: category.occurrence_count,
        stored_detail_count: category.stored_detail_count,
        archived_occurrence_count: categoryRows.length,
        first_at: category.first_at,
        last_at: category.last_at,
      });
    }

    files["manifest.json"] = Buffer.from(
      `${JSON.stringify(
        {
          build_id: buildId,
          generated_at: new Date().toISOString(),
          format: "classapp-incident-logs-v1",
          event_categories: eventCategories,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    return {
      zipName: archiveFileName(buildId),
      zipData: zipFiles(files),
    };
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError(
      "Incident logs 打包失败",
      "Incident log archive creation failed",
      error,
    );
  }
}

export class IncidentLogArchiveService {
  constructor(
    private readonly db: Database,
    private readonly buildId: string,
  ) {}

  build() {
    return buildIncidentLogArchive(this.db, this.buildId);
  }
}
