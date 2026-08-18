import type { ClientIdentity } from "@/server/infra/clientIdentity";
import type { RequestIdentity } from "@/server/runtime/scope";
import type { BusEvent } from "@/server/services/eventBus";
import type { StickyCommand } from "@/server/runtime/sticky";
import type { ActionResult } from "@/shared/protocol/result";
import type { MediaSearchHit } from "@/server/runtime/mediaRuntime";
import type { ArticleImportTask } from "@/server/services/articleImportService";
import type { User } from "@/shared/types/api";
import type { RuntimeConfig } from "@/server/infra/runtimeConfig";

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
  | "ai.abortUser";

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
      error: { message: string; name?: string };
    };
