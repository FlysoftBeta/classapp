import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeConversations(runtime: SmokeRuntime): Promise<void> {
  const snapshot = await runtime.client.expectOk("fetchConversationsAction", []);
  assert.ok(snapshot.entries.length >= 1);
  const wild = snapshot.entries.find(
    (entry) => entry.type === "group" && entry.id === "wild",
  );
  assert.ok(wild);
  assert.equal(wild.conv_id, "group:wild");
  assert.equal(wild.can_post, true);

  const revisions = await runtime.client.expectOk(
    "fetchConversationRevisionsAction",
    [],
  );
  assert.ok(revisions.revisions.some((entry) => entry.conv_id === "group:wild"));

  const pinned = await runtime.client.expectOk("setConversationPinnedAction", [
    { type: "group", id: "wild", pinned: true, updatedAt: Date.now() },
  ]);
  assert.equal(pinned.value, true);

  const muted = await runtime.client.expectOk("setConversationMutedAction", [
    { type: "group", id: "wild", muted: true, updatedAt: Date.now() },
  ]);
  assert.equal(muted.value, true);

  const draft = await runtime.client.expectOk("saveConversationDraftAction", [
    {
      type: "group",
      id: "wild",
      draft: "smoke draft",
      updatedAt: Date.now(),
    },
  ]);
  assert.equal(draft.draft, "smoke draft");
  const loaded = await runtime.client.expectOk("fetchConversationDraftAction", [
    { type: "group", id: "wild" },
  ]);
  assert.equal(loaded.draft, "smoke draft");
}
