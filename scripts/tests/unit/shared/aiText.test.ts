import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAiSearchText, provisionalAiTitle } from "@/shared/ai/text";

test("AI search text is NFKC-normalized, collapsed, and lowercased", () => {
  assert.equal(normalizeAiSearchText("  ＡＢＣ  测试\n"), "abc 测试");
});

test("provisional titles truncate at 32 code units", () => {
  assert.equal(provisionalAiTitle("   "), "新对话");
  assert.equal(provisionalAiTitle("短标题"), "短标题");
  const long = "字".repeat(40);
  assert.equal(provisionalAiTitle(long), `${"字".repeat(32)}…`);
});
