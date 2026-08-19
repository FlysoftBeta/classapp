import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { unzipSync } from "fflate";
import { IncidentService } from "@/server/services/incidentService";
import { buildIncidentLogArchive } from "@/server/services/incidentLogArchiveService";

test("incident log archive keeps current-build events and omits other builds", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE incident_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      environment TEXT NOT NULL,
      build_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      top_frame TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 0,
      stored_detail_count INTEGER NOT NULL DEFAULT 0,
      first_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      UNIQUE (environment, build_id, fingerprint)
    );
    CREATE TABLE incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT UNIQUE,
      group_id INTEGER NOT NULL REFERENCES incident_groups(id),
      occurred_at TEXT NOT NULL,
      error_name TEXT,
      message TEXT,
      stack TEXT,
      context_json TEXT,
      related_incident_ids_json TEXT
    );
  `);

  const service = new IncidentService(db, "build/current");
  function captureServerIncident() {
    service.capture({
      environment: "server",
      error: new Error("server failure"),
    });
  }
  captureServerIncident();
  captureServerIncident();
  service.capture({
    environment: "client",
    error: new TypeError("client failure"),
    context: { operation: "test" },
  });
  new IncidentService(db, "old-build").capture({
    environment: "server",
    error: new Error("old failure"),
  });

  const archive = buildIncidentLogArchive(db, "build/current");
  assert.equal(archive.zipName, "incident-logs-build-current.zip");
  const files = unzipSync(archive.zipData);
  const text = (name: string) => new TextDecoder().decode(files[name]);
  const manifest = JSON.parse(text("manifest.json")) as {
    build_id: string;
    event_categories: Array<{
      file: string;
      environment: string;
      archived_occurrence_count: number;
    }>;
  };
  assert.equal(manifest.build_id, "build/current");
  assert.equal(manifest.event_categories.length, 2);
  assert.deepEqual(
    manifest.event_categories.map((category) => category.environment).sort(),
    ["client", "server"],
  );
  for (const category of manifest.event_categories) {
    assert.match(category.file, /^events\/[a-f0-9]{64}\.jsonl$/);
  }
  assert.deepEqual(
    manifest.event_categories
      .map((category) => category.archived_occurrence_count)
      .sort(),
    [1, 2],
  );
  const eventLogs = manifest.event_categories
    .map((category) => text(category.file))
    .join("\n");
  assert.match(eventLogs, /server failure/);
  assert.match(eventLogs, /client failure/);
  assert.doesNotMatch(eventLogs, /old failure/);

  const emptyArchive = unzipSync(
    buildIncidentLogArchive(db, "missing-build").zipData,
  );
  const emptyManifest = JSON.parse(
    new TextDecoder().decode(emptyArchive["manifest.json"]),
  ) as { event_categories: unknown[] };
  assert.deepEqual(emptyManifest.event_categories, []);
  db.close();
});
