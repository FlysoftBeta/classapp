import type { AiModelsConfig } from "@/server/infra/aiModels";

export interface AiTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Prices are credits per million tokens. Multiplying by token count therefore
 * yields micro-credits directly; round only after aggregating one response.
 */
export function providerCostMicros(
  config: AiModelsConfig,
  modelName: string,
  usage: AiTokenUsage,
): number {
  const model = config.providerModels[modelName];
  if (!model) return 0;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return Math.round(
    uncached * model.input +
      usage.cachedInputTokens * model.cachedInput +
      usage.outputTokens * model.output,
  );
}
