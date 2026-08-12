import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runtimeConfig } from "@/server/infra/runtimeConfig";

const reasoningEffortSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const providerSchema = z
  .object({
    type: z.literal("openai"),
    baseUrl: z.string().url(),
    token: z.string().min(1),
  })
  .strict();

const providerModelSchema = z
  .object({
    cachedInput: z.number().nonnegative(),
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    contextSize: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    provider: z.string().min(1),
    model: z.string().min(1),
    capabilities: z
      .object({
        input: z.array(z.enum(["text", "image"])).min(1),
        reasoningEfforts: z.array(reasoningEffortSchema).min(1),
        functionCalling: z.boolean(),
        structuredOutputs: z.boolean(),
        responsesApi: z.literal(true),
      })
      .strict(),
  })
  .strict();

const harnessModelSchema = z
  .object({
    models: z.array(z.string().min(1)).min(1),
    maxRetries: z.number().int().min(0).max(5).default(1),
  })
  .strict();

export const AI_MODEL_PLACEHOLDERS = [
  "route_classifier",
  "chat_fast",
  "chat_reasoning",
  "chat_vision",
  "writing",
  "metadata",
  "search_tags",
  "context_compactor",
] as const;

const aiModelsConfigSchema = z
  .object({
    version: z.literal(1),
    providers: z.record(z.string(), providerSchema),
    providerModels: z.record(z.string(), providerModelSchema),
    models: z.object(
      Object.fromEntries(
        AI_MODEL_PLACEHOLDERS.map((name) => [name, harnessModelSchema]),
      ) as Record<
        (typeof AI_MODEL_PLACEHOLDERS)[number],
        typeof harnessModelSchema
      >,
    ),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [name, model] of Object.entries(config.providerModels)) {
      if (!(model.provider in config.providers)) {
        context.addIssue({
          code: "custom",
          path: ["providerModels", name, "provider"],
          message: "Unknown provider",
        });
      }
    }
    for (const [placeholder, route] of Object.entries(config.models)) {
      for (const name of route.models) {
        if (!(name in config.providerModels)) {
          context.addIssue({
            code: "custom",
            path: ["models", placeholder, "models"],
            message: `Unknown provider model: ${name}`,
          });
        }
      }
    }
    const compatible = (
      placeholder: AiModelPlaceholder,
      predicate: (model: AiProviderModel) => boolean,
    ) =>
      config.models[placeholder].models.some((name) => {
        const model = config.providerModels[name];
        return model ? predicate(model) : false;
      });
    for (const placeholder of [
      "route_classifier",
      "metadata",
      "search_tags",
      "context_compactor",
    ] as const) {
      if (
        !compatible(
          placeholder,
          (model) => model.capabilities.structuredOutputs,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["models", placeholder],
          message: "At least one model must support structured outputs",
        });
      }
    }
    if (!compatible("writing", (model) => model.capabilities.functionCalling)) {
      context.addIssue({
        code: "custom",
        path: ["models", "writing"],
        message: "At least one writing model must support function calling",
      });
    }
  });

export type AiModelsConfig = z.infer<typeof aiModelsConfigSchema>;
export type AiModelPlaceholder = (typeof AI_MODEL_PLACEHOLDERS)[number];
export type AiProviderModel = AiModelsConfig["providerModels"][string];

export type AiModelsStatus =
  | { available: true; config: AiModelsConfig; path: string }
  | { available: false; error: string; path: string };

let cached:
  { path: string; mtimeMs: number; status: AiModelsStatus } | undefined;

function configPath(): string {
  const runtime = runtimeConfig();
  return runtime.nodeEnv === "production"
    ? path.join(runtime.appDir, "models.json")
    : path.join(runtime.appDir, "worktree", "secrets", "models.json");
}

/** Load and validate provider configuration without ever exposing its token. */
export function aiModelsStatus(): AiModelsStatus {
  const target = configPath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return { available: false, path: target, error: "models.json 不存在" };
  }
  if (cached?.path === target && cached.mtimeMs === stat.mtimeMs) {
    return cached.status;
  }
  let status: AiModelsStatus;
  try {
    const parsed = aiModelsConfigSchema.safeParse(
      JSON.parse(fs.readFileSync(target, "utf8")),
    );
    status = parsed.success
      ? { available: true, config: parsed.data, path: target }
      : {
          available: false,
          path: target,
          error: `models.json 无效：${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("；")}`,
        };
  } catch (error) {
    status = {
      available: false,
      path: target,
      error: error instanceof Error ? error.message : "models.json 无法读取",
    };
  }
  cached = { path: target, mtimeMs: stat.mtimeMs, status };
  return status;
}

export function resolveAiModels(
  config: AiModelsConfig,
  placeholder: AiModelPlaceholder,
) {
  return config.models[placeholder].models.map((name) => ({
    name,
    model: config.providerModels[name]!,
    provider: config.providers[config.providerModels[name]!.provider]!,
  }));
}
