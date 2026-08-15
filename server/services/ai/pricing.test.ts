import assert from "node:assert/strict";
import test from "node:test";
import type { AiModelsConfig } from "@/server/infra/aiModels";
import { providerCostMicros } from "./pricing";
import { creditsFromMicros } from "@/server/data/ai";

const config = {
  providerModels: {
    test: { input: 1, cachedInput: 0.2, output: 2 },
  },
} as unknown as AiModelsConfig;

test("provider prices convert token usage to micro-credits without whole-credit rounding", () => {
  assert.equal(
    providerCostMicros(config, "test", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    }),
    1_000_000,
  );
  assert.equal(
    providerCostMicros(config, "test", {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
    }),
    88,
  );
  assert.equal(creditsFromMicros(88), 0.000088);
});

test("unknown provider models have no billable price", () => {
  assert.equal(
    providerCostMicros(config, "missing", {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 100,
    }),
    0,
  );
});
