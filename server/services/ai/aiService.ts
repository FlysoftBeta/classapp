import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { User } from "@/shared/types/api";
import { normalizeAiSearchText, provisionalAiTitle } from "@/shared/ai/text";
import {
  createAiConversation,
  createAiRunRecords,
  finishAndSettleAiRun,
  getAiConversationDetail,
  getAiMessage,
  getAiRun,
  isAiRunCancellationRequested,
  latestAiContextSnapshot,
  listAiBranchMessages,
  listAiConversations,
  markAiConversationRead,
  moveAiRunToConversation,
  purgeAiConversationData,
  requestAiRunCancellation,
  saveAiContextSnapshot,
  searchAiConversations,
  updateAiConversationMetadata,
  updateAiRunRouting,
  updateAiRunStream,
} from "@/server/data/ai";
import type { AiExecuteInput, AiSticky } from "@/server/runtime/sticky";
import type { AiBillingService } from "@/server/services/ai/aiBillingService";
import {
  aiModelsStatus,
  resolveAiModels,
  type AiModelPlaceholder,
  type AiModelsConfig,
} from "@/server/infra/aiModels";
import type { BlobStore } from "@/server/storage/blobStore";
import { AiWorkspace } from "@/server/services/ai/aiWorkspace";
import { BUILD_ID } from "@/server/infra/env";
import { publishUser } from "@/server/runtime/eventBus";
import {
  PublicError,
  recordContainedServerIncident,
} from "@/server/services/incidentService";
import { AI_FILE_TOOLS, executeAiFileTool } from "./fileTools";
import {
  addUsage,
  streamHarnessResponse,
  structuredResponse,
} from "./openaiHarness";
import {
  AGENT_SYSTEM_PROMPT,
  AI_PROMPT_VERSION,
  COMPACTION_PROMPT,
  METADATA_PROMPT,
  ROUTER_PROMPT,
  SEARCH_TAGS_PROMPT,
} from "./prompts";
import { providerCostMicros } from "./pricing";

type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type RouteDecision = {
  placeholder: "chat_fast" | "chat_reasoning" | "chat_vision" | "writing";
  reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  forkPlacement: "branch_in_place" | "new_conversation";
  maxToolRounds: number;
};

const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    placeholder: {
      type: "string",
      enum: ["chat_fast", "chat_reasoning", "chat_vision", "writing"],
    },
    reasoningEffort: {
      type: "string",
      enum: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    forkPlacement: {
      type: "string",
      enum: ["branch_in_place", "new_conversation"],
    },
    maxToolRounds: { type: "integer", minimum: 0, maximum: 8 },
  },
  required: [
    "placeholder",
    "reasoningEffort",
    "forkPlacement",
    "maxToolRounds",
  ],
  additionalProperties: false,
};

const METADATA_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 60 },
    tags: {
      type: "array",
      maxItems: 40,
      items: { type: "string", minLength: 1, maxLength: 80 },
    },
  },
  required: ["title", "tags"],
  additionalProperties: false,
};

const TAGS_SCHEMA = {
  type: "object",
  properties: {
    tags: {
      type: "array",
      maxItems: 30,
      items: { type: "string", minLength: 1, maxLength: 80 },
    },
  },
  required: ["tags"],
  additionalProperties: false,
};

const COMPACTION_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string", minLength: 1 } },
  required: ["summary"],
  additionalProperties: false,
};

function reservationFor(
  config: AiModelsConfig,
  content: string,
  imageCount = 0,
): number {
  const inputTokens =
    Math.ceil(content.length / 3) + 4_000 + imageCount * 20_000;
  const names = new Set<string>();
  for (const placeholder of [
    "chat_fast",
    "chat_reasoning",
    "chat_vision",
    "writing",
  ] as const) {
    for (const candidate of config.models[placeholder].models)
      names.add(candidate);
  }
  let maximum = 0;
  for (const name of names) {
    const model = config.providerModels[name]!;
    maximum = Math.max(
      maximum,
      Math.ceil(
        inputTokens * model.input + model.maxOutputTokens * model.output,
      ),
    );
  }
  const supporting = (
    placeholder: "route_classifier" | "metadata" | "context_compactor",
  ) =>
    config.models[placeholder].models.reduce((highest, name) => {
      const model = config.providerModels[name]!;
      return Math.max(
        highest,
        Math.ceil(
          inputTokens * model.input +
            Math.min(model.maxOutputTokens, 4096) * model.output,
        ),
      );
    }, 0);
  // Reserve the worst main call plus routing, one compaction, and metadata.
  return (
    maximum +
    supporting("route_classifier") +
    supporting("context_compactor") +
    supporting("metadata")
  );
}

function auxiliaryReservation(
  config: AiModelsConfig,
  placeholder: AiModelPlaceholder,
  content: string,
): number {
  const inputTokens = Math.ceil(content.length / 3) + 1_000;
  let maximum = 0;
  for (const name of config.models[placeholder].models) {
    const model = config.providerModels[name]!;
    maximum = Math.max(
      maximum,
      Math.ceil(
        inputTokens * model.input +
          Math.min(model.maxOutputTokens, 4096) * model.output,
      ),
    );
  }
  return maximum;
}

function routeFallback(
  config: AiModelsConfig,
  content: string,
  hasFork: boolean,
  hasImages: boolean,
): RouteDecision {
  const writing = /(?:写|撰写|文档|文章|草稿|文件|markdown|svg)/i.test(content);
  const hard =
    content.length > 1_500 ||
    /(?:分析|设计|架构|推理|比较|评估)/i.test(content);
  const placeholder = hasImages
    ? "chat_vision"
    : writing
      ? "writing"
      : hard
        ? "chat_reasoning"
        : "chat_fast";
  const preferred = hard ? "high" : "low";
  const supported = resolveAiModels(config, placeholder)
    .flatMap(({ model }) => model.capabilities.reasoningEfforts)
    .filter((effort, index, values) => values.indexOf(effort) === index);
  return {
    placeholder,
    reasoningEffort: (supported.includes(preferred)
      ? preferred
      : (supported[0] ?? "none")) as RouteDecision["reasoningEffort"],
    forkPlacement:
      hasFork && /(?:换个话题|另外|无关|新话题)/.test(content)
        ? "new_conversation"
        : "branch_in_place",
    maxToolRounds: writing ? 6 : 0,
  };
}

function routeIsCompatible(
  config: AiModelsConfig,
  route: RouteDecision,
  hasImages: boolean,
): boolean {
  return resolveAiModels(config, route.placeholder).some(
    ({ model }) =>
      model.capabilities.reasoningEfforts.includes(route.reasoningEffort) &&
      (!hasImages || model.capabilities.input.includes("image")) &&
      (route.placeholder !== "writing" || model.capabilities.functionCalling),
  );
}

async function messageItems(
  userId: string,
  messages: ReturnType<typeof listAiBranchMessages>,
  workspace: AiWorkspace,
) {
  return await Promise.all(
    messages.map(async (message) => {
      if (!message.attachments.length) {
        return {
          role: message.role,
          content: message.content,
        } as ResponseInputItem;
      }
      const images = await Promise.all(
        message.attachments.map(async (attachment) => ({
          type: "input_image" as const,
          image_url: await workspace.readAttachmentDataUrl(attachment),
          detail: "auto" as const,
        })),
      );
      return {
        role: message.role,
        content: [{ type: "input_text", text: message.content }, ...images],
      } as unknown as ResponseInputItem;
    }),
  );
}

export type AiRunControllers = {
  begin(runId: string): AbortController;
  finish(runId: string): void;
  abort(runId: string): void;
  abortUser(userId: string): void;
};

export class AiService {
  constructor(
    private readonly db: Database,
    private readonly executions: AiRunControllers,
    private readonly billing: AiBillingService,
    private readonly blobs: BlobStore,
    private readonly scheduleExecute: (input: AiExecuteInput) => void,
  ) {}

  status() {
    const models = aiModelsStatus();
    return models.available
      ? { available: true as const, error: null }
      : { available: false as const, error: models.error };
  }

  list(user: User) {
    return {
      conversations: listAiConversations(this.db, user.id),
      credits: this.billing.balance(user.id),
      status: this.status(),
    };
  }

  detail(user: User, conversationId: string) {
    const detail = getAiConversationDetail(this.db, user.id, conversationId);
    if (!detail) throw new PublicError("AI 对话不存在");
    return detail;
  }

  async purgeUser(userId: string): Promise<void> {
    this.executions.abortUser(userId);
    purgeAiConversationData(this.db, userId);
    await new AiWorkspace(this.db, userId, this.blobs).remove();
  }

  async search(user: User, query: string) {
    const normalized = normalizeAiSearchText(query);
    if (!normalized) return listAiConversations(this.db, user.id);
    let tags: string[] = [];
    const models = aiModelsStatus();
    if (models.available) {
      const operationId = crypto.randomUUID();
      const reserved = auxiliaryReservation(
        models.config,
        "search_tags",
        query,
      );
      const reservation = this.billing.reserveOperation(
        user.id,
        operationId,
        reserved,
      );
      if (!reservation)
        return searchAiConversations(this.db, user.id, query, []);
      let charged = 0;
      try {
        const response = await structuredResponse<{ tags: string[] }>({
          config: models.config,
          placeholder: "search_tags",
          instructions: SEARCH_TAGS_PROMPT,
          content: query,
          schemaName: "conversation_search_tags",
          schema: TAGS_SCHEMA,
          userId: user.id,
        });
        tags = response.value.tags.map(normalizeAiSearchText);
        charged = providerCostMicros(
          models.config,
          response.providerModel,
          response.usage,
        );
      } catch (error) {
        recordContainedServerIncident(this.db, BUILD_ID, error, {
          component: "ai-search-tags",
          user_id: user.id,
        });
      } finally {
        this.billing.settleOperation(user.id, operationId, charged);
        publishUser(user.id, {
          kind: "ai.sidebar.updated",
          data: { refresh: true },
        });
      }
    }
    return searchAiConversations(this.db, user.id, query, tags);
  }

  markRead(user: User, conversationId: string): void {
    if (!markAiConversationRead(this.db, user.id, conversationId)) {
      throw new PublicError("AI 对话不存在");
    }
    publishUser(user.id, {
      kind: "ai.sidebar.updated",
      data: { refresh: true },
    });
  }

  async start(
    user: User,
    input: {
      conversationId?: string;
      content: string;
      forkFromMessageId?: string;
      images?: Array<{
        name: string;
        mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
        data: string;
      }>;
    },
  ): Promise<
    | { status: "started"; runId: string; conversationId: string }
    | { status: "insufficient_credits"; required: number; available: number }
    | { status: "busy" }
    | { status: "unavailable"; error: string }
  > {
    const content = input.content.trim();
    if (!content) throw new PublicError("消息不能为空");
    if (content.length > 100_000) throw new PublicError("消息过长");
    const models = aiModelsStatus();
    if (!models.available)
      return { status: "unavailable", error: models.error };
    const imageInputs = input.images ?? [];
    if (
      imageInputs.length > 0 &&
      !resolveAiModels(models.config, "chat_vision").some(({ model }) =>
        model.capabilities.input.includes("image"),
      )
    ) {
      return {
        status: "unavailable",
        error: "当前配置的模型不支持图片输入",
      };
    }
    const conversationId = input.conversationId ?? crypto.randomUUID();
    const existingDetail = input.conversationId
      ? getAiConversationDetail(this.db, user.id, input.conversationId)
      : null;
    const existing = existingDetail?.conversation ?? null;
    if (input.conversationId && !existing)
      throw new PublicError("AI 对话不存在");
    if (existingDetail?.active_run) {
      return { status: "busy" };
    }
    const forkMessage = input.forkFromMessageId
      ? getAiMessage(this.db, user.id, input.forkFromMessageId)
      : null;
    if (input.forkFromMessageId && !forkMessage) {
      throw new PublicError("Fork 起点不存在");
    }
    if (forkMessage && forkMessage.conversation_id !== conversationId) {
      throw new PublicError("Fork 起点不属于当前对话");
    }
    const priorMessages = existingDetail?.messages ?? [];
    const reservationContent = `${priorMessages
      .map((message) => message.content)
      .join("\n")}\n${content}`;
    const priorImages = priorMessages.reduce(
      (total, message) => total + message.attachments.length,
      0,
    );
    const reserved = reservationFor(
      models.config,
      reservationContent,
      priorImages + imageInputs.length,
    );
    const quote = this.billing.quoteReservation(user.id, reserved);
    if (!quote.sufficient) {
      return {
        status: "insufficient_credits",
        required: quote.required,
        available: quote.available,
      };
    }

    const runId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const parentMessageId =
      forkMessage?.id ?? existing?.active_leaf_message_id ?? null;
    const decodedImages = imageInputs.map((image) => {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
        throw new PublicError("图片数据无效");
      }
      const bytes = Buffer.from(image.data, "base64");
      if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024) {
        throw new PublicError("单张图片必须小于 5 MB");
      }
      return { name: image.name, mime: image.mime, bytes };
    });
    const workspace = new AiWorkspace(this.db, user.id, this.blobs);
    const attachments = decodedImages.length
      ? await workspace.storeAttachments(decodedImages)
      : [];
    try {
      this.db.transaction(() => {
        if (!existing) {
          createAiConversation(this.db, {
            id: conversationId,
            userId: user.id,
            title: provisionalAiTitle(content),
          });
        }
        createAiRunRecords(this.db, {
          runId,
          conversationId,
          userId: user.id,
          parentMessageId,
          userMessageId,
          assistantMessageId,
          content,
          attachments,
          reservedCredits: reserved,
        });
        if (!this.billing.reserveRun(user.id, runId, reserved)) {
          throw new PublicError("Credits 不足");
        }
      })();
    } catch (error) {
      await workspace.deleteAttachments(
        attachments.map((attachment) => attachment.path),
      );
      if (
        error instanceof PublicError &&
        error.publicMessage === "Credits 不足"
      ) {
        const currentQuote = this.billing.quoteReservation(user.id, reserved);
        return {
          status: "insufficient_credits",
          required: currentQuote.required,
          available: currentQuote.available,
        };
      }
      throw error;
    }
    publishUser(user.id, {
      kind: "ai.sidebar.updated",
      data: { refresh: true },
    });
    this.scheduleExecute({
      user,
      runId,
      conversationId,
      originalLeaf: existing?.active_leaf_message_id ?? null,
      content,
      forkFromMessageId: forkMessage?.id ?? null,
      hasImages: attachments.length > 0,
      config: models.config,
    });
    return { status: "started", runId, conversationId };
  }

  cancel(user: User, runId: string): boolean {
    const changed = requestAiRunCancellation(this.db, user.id, runId);
    this.executions.abort(runId);
    return changed;
  }

  private publish(userId: string, runId: string): void {
    const run = getAiRun(this.db, userId, runId);
    if (!run) return;
    const detail = getAiConversationDetail(
      this.db,
      userId,
      run.conversation_id,
    );
    const message = detail?.messages.find(
      (entry) => entry.id === run.output_message_id,
    );
    if (!detail || !message) return;
    publishUser(userId, {
      kind: "ai.run.updated",
      data: { run, conversation: detail.conversation, message },
    });
  }

  private async route(
    user: User,
    config: AiModelsConfig,
    content: string,
    hasFork: boolean,
    hasImages: boolean,
    usage: Usage,
  ): Promise<{ decision: RouteDecision; charged: number }> {
    try {
      const response = await structuredResponse<RouteDecision>({
        config,
        placeholder: "route_classifier",
        instructions: ROUTER_PROMPT,
        content: JSON.stringify({ message: content, hasFork, hasImages }),
        schemaName: "agent_route",
        schema: ROUTE_SCHEMA,
        userId: user.id,
      });
      addUsage(usage, response.usage);
      const decision = routeIsCompatible(config, response.value, hasImages)
        ? response.value
        : routeFallback(config, content, hasFork, hasImages);
      return {
        decision,
        charged: providerCostMicros(
          config,
          response.providerModel,
          response.usage,
        ),
      };
    } catch (error) {
      recordContainedServerIncident(this.db, BUILD_ID, error, {
        component: "ai-router",
        user_id: user.id,
      });
      return {
        decision: routeFallback(config, content, hasFork, hasImages),
        charged: 0,
      };
    }
  }

  private async compactContext(input: {
    user: User;
    config: AiModelsConfig;
    conversationId: string;
    messages: ReturnType<typeof listAiBranchMessages>;
    contextSize: number;
    usage: Usage;
  }): Promise<{
    summary: string | null;
    recent: typeof input.messages;
    charged: number;
  }> {
    const existing = latestAiContextSnapshot(this.db, input.conversationId);
    if (existing) {
      const index = input.messages.findIndex(
        (message) => message.id === existing.through_message_id,
      );
      if (index >= 0) {
        const parsed = JSON.parse(existing.summary_json) as {
          summary?: string;
        };
        return {
          summary: parsed.summary ?? null,
          recent: input.messages.slice(index + 1),
          charged: 0,
        };
      }
    }
    const characters = input.messages.reduce(
      (sum, message) => sum + message.content.length,
      0,
    );
    if (characters < input.contextSize * 2.2 || input.messages.length < 8) {
      return { summary: null, recent: input.messages, charged: 0 };
    }
    const split = Math.max(2, Math.floor(input.messages.length * 0.6));
    const older = input.messages.slice(0, split);
    const response = await structuredResponse<{ summary: string }>({
      config: input.config,
      placeholder: "context_compactor",
      instructions: COMPACTION_PROMPT,
      content: older
        .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
        .join("\n\n"),
      schemaName: "conversation_compaction",
      schema: COMPACTION_SCHEMA,
      userId: input.user.id,
    });
    addUsage(input.usage, response.usage);
    saveAiContextSnapshot(this.db, {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      throughMessageId: older.at(-1)!.id,
      summary: response.value,
      promptVersion: AI_PROMPT_VERSION,
    });
    return {
      summary: response.value.summary,
      recent: input.messages.slice(split),
      charged: providerCostMicros(
        input.config,
        response.providerModel,
        response.usage,
      ),
    };
  }

  async execute(input: AiExecuteInput): Promise<void> {
    const controller = this.executions.begin(input.runId);
    const usage: Usage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    let charged = 0;
    let output = "";
    try {
      updateAiRunRouting(this.db, input.runId, { status: "routing" });
      this.publish(input.user.id, input.runId);
      const routed = await this.route(
        input.user,
        input.config,
        input.content,
        !!input.forkFromMessageId,
        input.hasImages,
        usage,
      );
      charged += routed.charged;
      const route = routed.decision;
      if (
        input.forkFromMessageId &&
        route.forkPlacement === "new_conversation"
      ) {
        const nextConversationId = crypto.randomUUID();
        createAiConversation(this.db, {
          id: nextConversationId,
          userId: input.user.id,
          title: provisionalAiTitle(input.content),
          forkedFromConversationId: input.conversationId,
          forkedFromMessageId: input.forkFromMessageId,
        });
        moveAiRunToConversation(this.db, {
          runId: input.runId,
          oldConversationId: input.conversationId,
          newConversationId: nextConversationId,
          oldActiveLeafMessageId: input.originalLeaf,
        });
        input.conversationId = nextConversationId;
        publishUser(input.user.id, {
          kind: "ai.sidebar.updated",
          data: { refresh: true },
        });
      }
      const firstModel = resolveAiModels(input.config, route.placeholder).find(
        ({ model }) =>
          model.capabilities.reasoningEfforts.includes(route.reasoningEffort) &&
          (!input.hasImages || model.capabilities.input.includes("image")) &&
          (route.placeholder !== "writing" ||
            model.capabilities.functionCalling),
      );
      if (!firstModel) throw new Error(`No model for ${route.placeholder}`);
      updateAiRunRouting(this.db, input.runId, {
        status: "running",
        placeholder: route.placeholder,
        providerModel: firstModel.name,
        reasoningEffort: route.reasoningEffort,
      });
      const branch = listAiBranchMessages(
        this.db,
        input.user.id,
        input.conversationId,
        getAiRun(this.db, input.user.id, input.runId)?.input_message_id,
      );
      let compacted: Awaited<ReturnType<AiService["compactContext"]>>;
      try {
        compacted = await this.compactContext({
          user: input.user,
          config: input.config,
          conversationId: input.conversationId,
          messages: branch,
          contextSize: firstModel.model.contextSize,
          usage,
        });
      } catch (error) {
        recordContainedServerIncident(this.db, BUILD_ID, error, {
          component: "ai-context-compaction",
          run_id: input.runId,
          user_id: input.user.id,
        });
        let characters = 0;
        const recent = [...branch]
          .reverse()
          .filter((message) => {
            characters += message.content.length;
            return characters <= firstModel.model.contextSize * 2;
          })
          .reverse();
        compacted = { summary: null, recent, charged: 0 };
      }
      charged += compacted.charged;
      const workspace = new AiWorkspace(this.db, input.user.id, this.blobs);
      const workspaceCatalog = await workspace.inspect();
      let instructions = AGENT_SYSTEM_PROMPT;
      if (compacted.summary) {
        instructions += `\n\n<prior_context_summary>\n${compacted.summary}\n</prior_context_summary>`;
      }
      instructions += `\n\n<workspace_catalog revision="${workspaceCatalog.revision}">\n${workspaceCatalog.files
        .map((file) => `${file.path} (${file.size} bytes)`)
        .join("\n")}\n</workspace_catalog>`;
      let items = await messageItems(
        input.user.id,
        compacted.recent,
        workspace,
      );
      let lastPersist = 0;
      for (let round = 0; round <= route.maxToolRounds; round += 1) {
        if (
          controller.signal.aborted ||
          isAiRunCancellationRequested(this.db, input.runId)
        ) {
          throw new DOMException("Cancelled", "AbortError");
        }
        const response = await streamHarnessResponse({
          config: input.config,
          placeholder: route.placeholder,
          instructions,
          items,
          tools: round < route.maxToolRounds ? AI_FILE_TOOLS : [],
          reasoningEffort: route.reasoningEffort,
          userId: input.user.id,
          signal: controller.signal,
          onDelta: (delta) => {
            output += delta;
            const now = Date.now();
            if (
              now - lastPersist >= 250 ||
              output.length % 512 < delta.length
            ) {
              lastPersist = now;
              updateAiRunStream(this.db, input.runId, output);
              this.publish(input.user.id, input.runId);
            }
          },
        });
        addUsage(usage, response.usage);
        charged += providerCostMicros(
          input.config,
          response.providerModel,
          response.usage,
        );
        updateAiRunRouting(this.db, input.runId, {
          status: "running",
          providerModel: response.providerModel,
        });
        if (!response.toolCalls.length) {
          if (!output && response.text) output = response.text;
          break;
        }
        const toolOutputs: ResponseInputItem[] = [];
        for (const call of response.toolCalls) {
          const result = await executeAiFileTool({
            db: this.db,
            userId: input.user.id,
            runId: input.runId,
            call,
            workspace,
          });
          toolOutputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: result,
          } as ResponseInputItem);
        }
        items = [
          ...items,
          ...(response.response.output as unknown as ResponseInputItem[]),
          ...toolOutputs,
        ];
      }
      updateAiRunStream(this.db, input.runId, output);
      try {
        const metadata = await structuredResponse<{
          title: string;
          tags: string[];
        }>({
          config: input.config,
          placeholder: "metadata",
          instructions: METADATA_PROMPT,
          content: `USER:\n${input.content}\n\nASSISTANT:\n${output.slice(0, 20_000)}`,
          schemaName: "conversation_metadata",
          schema: METADATA_SCHEMA,
          userId: input.user.id,
        });
        addUsage(usage, metadata.usage);
        charged += providerCostMicros(
          input.config,
          metadata.providerModel,
          metadata.usage,
        );
        const title = metadata.value.title.trim().slice(0, 60);
        const tags = metadata.value.tags
          .map((display) => ({
            display: display.trim(),
            normalized: normalizeAiSearchText(display),
          }))
          .filter((tag) => tag.display && tag.normalized);
        updateAiConversationMetadata(
          this.db,
          input.user.id,
          input.conversationId,
          title || provisionalAiTitle(input.content),
          tags,
          AI_PROMPT_VERSION,
        );
      } catch (error) {
        recordContainedServerIncident(this.db, BUILD_ID, error, {
          component: "ai-metadata",
          run_id: input.runId,
          user_id: input.user.id,
        });
      }
      const billing = this.billing.runReservation(input.runId)!;
      const finalCharge = Math.min(billing.reserved_credit_micros, charged);
      finishAndSettleAiRun(this.db, input.runId, {
        status: "completed",
        content: output,
        chargedCreditMicros: finalCharge,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
      });
      this.publish(input.user.id, input.runId);
      publishUser(input.user.id, {
        kind: "ai.sidebar.updated",
        data: { refresh: true },
      });
    } catch (error) {
      const cancelled =
        error instanceof DOMException && error.name === "AbortError";
      const billing = this.billing.runReservation(input.runId);
      const finalCharge = Math.min(
        billing?.reserved_credit_micros ?? 0,
        charged,
      );
      finishAndSettleAiRun(this.db, input.runId, {
        status: cancelled ? "cancelled" : "failed",
        content: output,
        error: cancelled ? null : "AI 暂时无法完成请求",
        chargedCreditMicros: finalCharge,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
      });
      this.publish(input.user.id, input.runId);
      publishUser(input.user.id, {
        kind: "ai.sidebar.updated",
        data: { refresh: true },
      });
      if (!cancelled) {
        recordContainedServerIncident(this.db, BUILD_ID, error, {
          component: "ai-run",
          run_id: input.runId,
          user_id: input.user.id,
        });
      }
    } finally {
      this.executions.finish(input.runId);
    }
  }
}

export function createAiService(
  db: Database,
  executions: AiRunControllers,
  billing: AiBillingService,
  blobs: BlobStore,
  scheduleExecute: (input: AiExecuteInput) => void,
): AiService {
  return new AiService(db, executions, billing, blobs, scheduleExecute);
}

export function aiControllersFromSticky(ai: AiSticky): AiRunControllers {
  return {
    abort: (runId) => ai.abort(runId),
    abortUser: (userId) => ai.abortUser(userId),
    begin: () => {
      throw new Error("AI execution belongs on the Coordinator");
    },
    finish: () => undefined,
  };
}
