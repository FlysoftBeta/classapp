import assert from "node:assert/strict";
import test from "node:test";
import { aiAccountingWindow } from "@/server/data/ai";

test("AI accounting uses every UTC calendar day, including weekends", () => {
  const saturday = aiAccountingWindow(new Date("2026-08-15T12:00:00Z"));
  const sunday = aiAccountingWindow(new Date("2026-08-16T12:00:00Z"));

  assert.deepEqual(saturday, { day: "2026-08-15", week: "2026-08-10" });
  assert.deepEqual(sunday, { day: "2026-08-16", week: "2026-08-10" });
});

test("weekly accounting changes at UTC Monday without weekday enforcement", () => {
  assert.deepEqual(aiAccountingWindow(new Date("2026-08-17T00:00:00Z")), {
    day: "2026-08-17",
    week: "2026-08-17",
  });
});
