import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { IncidentService } from "./incidentService";

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
    group_id INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    error_name TEXT,
    message TEXT,
    stack TEXT,
    context_json TEXT,
    related_incident_ids_json TEXT
  );
`);

const service = new IncidentService(db, "test-build");
const ids: string[] = [];
for (let occurrence = 0; occurrence < 12; occurrence += 1) {
  const error = new Error(`variable message ${occurrence}`);
  error.stack = `Error: variable message ${occurrence}\n    at sameSite (server/test.ts:10:2)`;
  ids.push(service.capture({ environment: "server", error }).incidentId);
}

assert.equal(new Set(ids).size, 12);
assert.ok(ids.every((id) => /^I_[A-Za-z0-9_-]{22}$/.test(id)));
assert.deepEqual(
  db
    .prepare(
      "SELECT occurrence_count, stored_detail_count FROM incident_groups",
    )
    .get(),
  { occurrence_count: 12, stored_detail_count: 10 },
);
assert.deepEqual(
  db
    .prepare("SELECT error_name, message, stack FROM incidents WHERE id = 12")
    .get(),
  { error_name: null, message: null, stack: null },
);

const blobSymbolicator = {
  symbolize(
    _environment: "client" | "server",
    _buildId: string,
    stack: string,
  ) {
    return stack.replace(
      /blob:https:\/\/classapp\.test\/[^:]+/,
      "client/app.ts",
    );
  },
};
const clientService = new IncidentService(db, "test-build", blobSymbolicator);
for (const blobId of ["first-random-id", "second-random-id"]) {
  const error = new Error("same browser failure");
  error.stack = `Error: same browser failure\n    at a (blob:https://classapp.test/${blobId}:1:42)`;
  clientService.capture({ environment: "client", error });
}
assert.deepEqual(
  db
    .prepare(
      "SELECT occurrence_count FROM incident_groups WHERE environment = 'client'",
    )
    .get(),
  { occurrence_count: 2 },
);

db.close();
console.log("incident service tests passed");
