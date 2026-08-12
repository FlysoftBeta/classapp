import crypto from "node:crypto";
import OpenAI from "openai";
import type {
  FunctionTool,
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseUsage,
} from "openai/resources/responses/responses";
import type {
  AiModelPlaceholder,
  AiModelsConfig,
} from "@/server/infra/aiModels";
import { resolveAiModels } from "@/server/infra/aiModels";

type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type HarnessResponse = {
  text: string;
  response: Response;
  toolCalls: ResponseFunctionToolCall[];
  usage: Usage;
  providerModel: string;
};

const clients = new Map<string, OpenAI>();

function clientFor(baseUrl: string, token: string): OpenAI {
  const key = crypto
    .createHash("sha256")
    .update(`${baseUrl}\0${token}`)
    .digest("hex");
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({
      apiKey: token,
      baseURL: baseUrl,
      maxRetries: 0,
      timeout: 120_000,
    });
    clients.set(key, client);
  }
  return client;
}

function usageOf(usage: ResponseUsage | undefined | null): Usage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

function transient(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true;
  if (!(error instanceof OpenAI.APIError)) return false;
  return (
    error.status === 408 ||
    error.status === 409 ||
    error.status === 429 ||
    (typeof error.status === "number" && error.status >= 500)
  );
}

function reasoning(effort: string | null | undefined) {
  return effort ? { effort } : undefined;
}

function safeIdentifier(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

export async function structuredResponse<T>(input: {
  config: AiModelsConfig;
  placeholder: AiModelPlaceholder;
  instructions: string;
  content: string;
  schemaName: string;
  schema: Record<string, unknown>;
  userId: string;
  signal?: AbortSignal;
  reasoningEffort?: string;
}): Promise<{ value: T; usage: Usage; providerModel: string }> {
  const route = input.config.models[input.placeholder];
  const effort = input.reasoningEffort ?? "none";
  let lastError: unknown;
  for (const candidate of resolveAiModels(input.config, input.placeholder)) {
    if (
      !candidate.model.capabilities.reasoningEfforts.includes(effort as never)
    ) {
      continue;
    }
    for (let attempt = 0; attempt <= route.maxRetries; attempt += 1) {
      try {
        const response = await clientFor(
          candidate.provider.baseUrl,
          candidate.provider.token,
        ).responses.create(
          {
            model: candidate.model.model,
            instructions: input.instructions,
            input: input.content,
            store: false,
            max_output_tokens: Math.min(candidate.model.maxOutputTokens, 4096),
            reasoning: reasoning(effort) as never,
            safety_identifier: safeIdentifier(input.userId),
            text: {
              verbosity: "low",
              format: {
                type: "json_schema",
                name: input.schemaName,
                strict: true,
                schema: input.schema,
              },
            },
          },
          { signal: input.signal, maxRetries: 0 },
        );
        return {
          value: JSON.parse(response.output_text) as T,
          usage: usageOf(response.usage),
          providerModel: candidate.name,
        };
      } catch (error) {
        lastError = error;
        if (!transient(error) || attempt >= route.maxRetries) break;
      }
    }
  }
  throw lastError ?? new Error(`No model configured for ${input.placeholder}`);
}

export async function streamHarnessResponse(input: {
  config: AiModelsConfig;
  placeholder: AiModelPlaceholder;
  instructions: string;
  items: string | ResponseInputItem[];
  tools: FunctionTool[];
  reasoningEffort: string;
  userId: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}): Promise<HarnessResponse> {
  const route = input.config.models[input.placeholder];
  let lastError: unknown;
  for (const candidate of resolveAiModels(input.config, input.placeholder)) {
    if (!candidate.model.capabilities.functionCalling && input.tools.length) {
      continue;
    }
    if (
      !candidate.model.capabilities.reasoningEfforts.includes(
        input.reasoningEffort as never,
      )
    ) {
      continue;
    }
    for (let attempt = 0; attempt <= route.maxRetries; attempt += 1) {
      let visible = false;
      try {
        const stream = await clientFor(
          candidate.provider.baseUrl,
          candidate.provider.token,
        ).responses.create(
          {
            model: candidate.model.model,
            instructions: input.instructions,
            input: input.items,
            store: false,
            stream: true,
            max_output_tokens: candidate.model.maxOutputTokens,
            reasoning: reasoning(input.reasoningEffort) as never,
            tools: input.tools,
            parallel_tool_calls: false,
            safety_identifier: safeIdentifier(input.userId),
            text: { verbosity: "medium" },
          },
          { signal: input.signal, maxRetries: 0 },
        );
        let completed: Response | null = null;
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") {
            visible = true;
            input.onDelta(event.delta);
          } else if (event.type === "response.completed") {
            completed = event.response;
          } else if (event.type === "response.failed") {
            throw new Error(
              event.response.error?.message ?? "Model response failed",
            );
          } else if (event.type === "response.incomplete") {
            throw new Error("Model response incomplete");
          }
        }
        if (!completed)
          throw new Error("Model stream ended without completion");
        return {
          text: completed.output_text,
          response: completed,
          toolCalls: completed.output.filter(
            (item): item is ResponseFunctionToolCall =>
              item.type === "function_call",
          ),
          usage: usageOf(completed.usage),
          providerModel: candidate.name,
        };
      } catch (error) {
        lastError = error;
        // Once text was shown, switching models could duplicate or contradict it.
        if (visible) throw error;
        if (!transient(error) || attempt >= route.maxRetries) break;
      }
    }
  }
  throw lastError ?? new Error(`No compatible model for ${input.placeholder}`);
}

export function addUsage(target: Usage, value: Usage): void {
  target.inputTokens += value.inputTokens;
  target.cachedInputTokens += value.cachedInputTokens;
  target.outputTokens += value.outputTokens;
}
