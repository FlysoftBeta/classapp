import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeAnnouncement(runtime: SmokeRuntime): Promise<void> {
  const announcement = await runtime.client.expectOk(
    "fetchAnnouncementAction",
    [],
  );
  assert.equal(typeof announcement.content, "string");
  assert.equal(typeof announcement.revision, "number");
  const ack = await runtime.client.expectOk("acknowledgeAnnouncementAction", [
    announcement.revision,
  ]);
  assert.equal(ack.ok, true);
}
