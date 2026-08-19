import type { ClientIdentity } from "@/server/infra/clientIdentity";
import type { RequestIdentity } from "@/server/runtime/scope";
import type { BusEvent } from "@/server/services/eventBus";
import type { StickyCommand } from "@/server/runtime/sticky";
import type { ActionResult } from "@/shared/protocol/result";
import type { MediaSearchHit } from "@/server/runtime/mediaRuntime";
import type { ArticleImportTask } from "@/server/services/articleImportService";
import type { User } from "@/shared/types/api";
import type { RuntimeConfig } from "@/server/infra/runtimeConfig";
import type { UpdateStatusView } from "@/server/infra/update/manager";
import {
  ContractViolationError,
  PublicError,
} from "@/server/services/incidentService";

export interface ExecutorWorkerData {
  config: RuntimeConfig;
  mediaAvailable: boolean;
  teachMonitorAvailable: boolean;
}

export type ExecutorJobBody =
  | {
      kind: "action";
      action: string;
      args: unknown;
      identity: RequestIdentity;
      requestId: string;
    }
  | {
      kind: "authenticate";
      claimedUserId: string;
      token: string;
      identity: ClientIdentity;
    };

export type ExecutorJob = ExecutorJobBody & { id: string };

export type AuthenticateJobResult = {
  userId: string;
  clientId: string | null;
  channels: string[];
};

export type ExecutorJobResult = {
  id: string;
  events: BusEvent[];
  commands: StickyCommand[];
  outcome: ActionResult<unknown>;
};

export type StickyRpcMethod =
  | "media.search"
  | "articleImport.search"
  | "articleImport.start"
  | "articleImport.list"
  | "teach.evict"
  | "ai.abort"
  | "ai.abortUser"
  | "update.status"
  | "update.cloudConfigChanged"
  | "update.checkCloud"
  | "update.installCloud"
  | "update.confirm"
  | "update.rollback";

export type StickyRpcArgs = {
  "media.search": [query: string, limit: number];
  "articleImport.search": [userId: string, query: string];
  "articleImport.start": [
    user: User,
    bookId: string,
    groupId: string,
    titleHint: string,
  ];
  "articleImport.list": [userId: string];
  "teach.evict": [id: string];
  "ai.abort": [runId: string];
  "ai.abortUser": [userId: string];
  "update.status": [];
  "update.cloudConfigChanged": [];
  "update.checkCloud": [];
  "update.installCloud": [];
  "update.confirm": [];
  "update.rollback": [];
};

export type StickyRpcResult = {
  "media.search": MediaSearchHit[];
  "articleImport.search": Awaited<
    ReturnType<
      import("@/server/services/articleImportService").ArticleImportRuntime["search"]
    >
  >;
  "articleImport.start": ArticleImportTask;
  "articleImport.list": ArticleImportTask[];
  "teach.evict": boolean;
  "ai.abort": void;
  "ai.abortUser": void;
  "update.status": UpdateStatusView;
  "update.cloudConfigChanged": void;
  "update.checkCloud": { build_id: string; update_available: boolean };
  "update.installCloud": void;
  "update.confirm": void;
  "update.rollback": void;
};

export type WorkerMessage =
  | { type: "ready" }
  | { type: "done"; result: ExecutorJobResult }
  | {
      type: "rpc";
      rpcId: string;
      method: StickyRpcMethod;
      args: unknown[];
    };

export type ParentMessage =
  | { type: "job"; job: ExecutorJob }
  | { type: "shutdown" }
  | {
      type: "rpc-result";
      rpcId: string;
      ok: true;
      value: unknown;
    }
  | {
      type: "rpc-result";
      rpcId: string;
      ok: false;
      error: StickyRpcError;
    };

export type StickyRpcError = {
  message: string;
  name?: string;
  publicMessage?: string;
};

export function serializeStickyError(error: unknown): StickyRpcError {
  if (error instanceof PublicError) {
    return {
      message: error.message,
      name: error.name,
      publicMessage: error.publicMessage,
    };
  }
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }
  return { message: String(error) };
}

export function reviveStickyError(error: StickyRpcError): Error {
  if (error.name === "ContractViolationError") {
    return new ContractViolationError(error.message);
  }
  if (error.name === "PublicError") {
    return new PublicError(error.publicMessage ?? error.message, error.message);
  }
  const revived = new Error(error.message);
  if (error.name) revived.name = error.name;
  return revived;
}
