import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
  FunctionTool,
  ResponseFunctionToolCall,
} from "openai/resources/responses/responses";
import {
  getAiFileOperation,
  planAiFileOperation,
  finishAiFileOperation,
} from "@/server/data/ai";
import type { AiWorkspace } from "@/server/services/ai/aiWorkspace";

const pathProperty = {
  type: "string",
  description: "Semantic relative path ending in .txt, .md, or .svg.",
};

export const AI_FILE_TOOLS: FunctionTool[] = [
  {
    type: "function",
    name: "list_files",
    description: "List the user's writing workspace and its current revision.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read one existing UTF-8 text, Markdown, or SVG file.",
    strict: true,
    parameters: {
      type: "object",
      properties: { path: pathProperty },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_file",
    description:
      "Create a new file once. This fails if the semantic path already exists.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: pathProperty,
        content: {
          type: "string",
          description: "Complete UTF-8 file content.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "replace_text",
    description:
      "Modify an exact part of an existing file. The operation fails if the old text occurrence count differs from the declared count.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: pathProperty,
        oldText: { type: "string" },
        newText: { type: "string" },
        expectedReplacements: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["path", "oldText", "newText", "expectedReplacements"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "delete_file",
    description:
      "Delete an existing file. Deletion remains allowed at the size limit.",
    strict: true,
    parameters: {
      type: "object",
      properties: { path: pathProperty },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

function parseArguments(
  call: ResponseFunctionToolCall,
): Record<string, unknown> {
  const value = JSON.parse(call.arguments) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

async function mutationResult(input: {
  db: Database;
  userId: string;
  runId: string;
  call: ResponseFunctionToolCall;
  workspace: AiWorkspace;
  mutation:
    | { kind: "create"; path: string; content: string }
    | {
        kind: "replace";
        path: string;
        oldText: string;
        newText: string;
        expectedReplacements: number;
      }
    | { kind: "delete"; path: string };
}) {
  const existing = getAiFileOperation(
    input.db,
    input.userId,
    input.call.call_id,
  );
  if (existing?.status === "committed" && existing.result_json) {
    return JSON.parse(existing.result_json) as unknown;
  }
  const before = await input.workspace.inspect();
  if (existing?.status === "planned") {
    let current: string | null = null;
    try {
      current = (await input.workspace.read(input.mutation.path)).content;
    } catch {
      // A missing file is the expected committed state only for delete.
    }
    const recoveredCreate =
      input.mutation.kind === "create" && current === input.mutation.content;
    const recoveredDelete =
      input.mutation.kind === "delete" && current === null;
    const recoveredReplace =
      input.mutation.kind === "replace" &&
      current !== null &&
      current.split(input.mutation.oldText).length - 1 === 0 &&
      (input.mutation.newText
        ? current.split(input.mutation.newText).length - 1 >=
          input.mutation.expectedReplacements
        : before.revision === existing.after_revision);
    if (recoveredCreate || recoveredDelete || recoveredReplace) {
      const recovered = {
        ok: true,
        recovered: true,
        revision: before.revision,
        files: before.files,
      };
      finishAiFileOperation(
        input.db,
        input.userId,
        input.call.call_id,
        recovered,
      );
      return recovered;
    }
  }
  if (!existing) {
    planAiFileOperation(input.db, {
      id: crypto.randomUUID(),
      userId: input.userId,
      runId: input.runId,
      callId: input.call.call_id,
      beforeRevision: before.revision,
      afterRevision: before.revision + 1,
    });
  }
  try {
    const result = {
      ok: true,
      ...(await input.workspace.mutate(input.mutation)),
    };
    finishAiFileOperation(input.db, input.userId, input.call.call_id, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishAiFileOperation(
      input.db,
      input.userId,
      input.call.call_id,
      null,
      message,
    );
    return { ok: false, error: message };
  }
}

export async function executeAiFileTool(input: {
  db: Database;
  userId: string;
  runId: string;
  call: ResponseFunctionToolCall;
  workspace: AiWorkspace;
}): Promise<string> {
  try {
    const args = parseArguments(input.call);
    let result: unknown;
    switch (input.call.name) {
      case "list_files":
        result = { ok: true, ...(await input.workspace.inspect()) };
        break;
      case "read_file": {
        const file = await input.workspace.read(stringArg(args, "path"));
        result = {
          ok: true,
          ...file,
          content:
            file.content.length <= 200_000
              ? file.content
              : `${file.content.slice(0, 200_000)}\n[truncated]`,
        };
        break;
      }
      case "create_file":
        result = await mutationResult({
          ...input,
          mutation: {
            kind: "create",
            path: stringArg(args, "path"),
            content: stringArg(args, "content"),
          },
        });
        break;
      case "replace_text": {
        const count = args.expectedReplacements;
        if (
          !Number.isInteger(count) ||
          Number(count) < 1 ||
          Number(count) > 100
        ) {
          throw new Error(
            "expectedReplacements must be an integer from 1 to 100",
          );
        }
        result = await mutationResult({
          ...input,
          mutation: {
            kind: "replace",
            path: stringArg(args, "path"),
            oldText: stringArg(args, "oldText"),
            newText: stringArg(args, "newText"),
            expectedReplacements: Number(count),
          },
        });
        break;
      }
      case "delete_file":
        result = await mutationResult({
          ...input,
          mutation: { kind: "delete", path: stringArg(args, "path") },
        });
        break;
      default:
        result = { ok: false, error: `Unknown tool: ${input.call.name}` };
    }
    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
