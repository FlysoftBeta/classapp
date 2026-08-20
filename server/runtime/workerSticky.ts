import { parentPort } from "node:worker_threads";
import {
  reviveStickyError,
  type ParentMessage,
  type StickyRpcArgs,
  type StickyRpcMethod,
  type StickyRpcResult,
  type WorkerMessage,
} from "@/server/runtime/executorIpc";
import type { StickyCommand, StickyHost } from "@/server/runtime/sticky";
import { PublicError } from "@/server/services/incidentService";

function send(message: WorkerMessage): void {
  parentPort!.postMessage(message);
}

export function createWorkerStickyHost(input: {
  mediaAvailable: boolean;
  teachMonitorAvailable: boolean;
  queueCommand: (command: StickyCommand) => void;
}): StickyHost {
  return {
    media: {
      available: input.mediaAvailable,
      search: (query, limit) => rpc("media.search", [query, limit]),
      prepare: (track, kind) =>
        input.queueCommand({ type: "media.ensureMaterialized", track, kind }),
    },
    articleImports: {
      search: (userId, query) => rpc("articleImport.search", [userId, query]),
      start: (user, bookId, groupId, titleHint = "") =>
        rpc("articleImport.start", [user, bookId, groupId, titleHint]),
      list: (userId) => rpc("articleImport.list", [userId]),
    },
    teachDocuments: {
      monitorAvailable: input.teachMonitorAvailable,
      evict: (id) => rpc("teach.evict", [id]),
    },
    ai: {
      abort: (runId) => {
        void rpc("ai.abort", [runId]);
      },
      abortUser: (userId) => {
        void rpc("ai.abortUser", [userId]);
      },
      execute: (payload) =>
        input.queueCommand({ type: "ai.execute", input: payload }),
    },
    postImages: {
      prepare: (imageId) =>
        input.queueCommand({ type: "postImage.ensureThumbnail", imageId }),
    },
    update: {
      status: () => rpc("update.status", []),
      cloudConfigChanged: () => {
        void rpc("update.cloudConfigChanged", []);
      },
      checkCloud: () => rpc("update.checkCloud", []),
      installCloud: () => rpc("update.installCloud", []),
      confirm: () => rpc("update.confirm", []),
      rollback: () => rpc("update.rollback", []),
      deploy: () => {
        throw new PublicError("部署包必须由 HTTP 入口在 Coordinator 上处理");
      },
    },
  };
}

const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

function rpc<K extends StickyRpcMethod>(
  method: K,
  args: StickyRpcArgs[K],
): Promise<StickyRpcResult[K]> {
  const rpcId = crypto.randomUUID();
  const result = new Promise<StickyRpcResult[K]>((resolve, reject) => {
    pending.set(rpcId, {
      resolve: (value) => resolve(value as StickyRpcResult[K]),
      reject,
    });
  });
  send({ type: "rpc", rpcId, method, args });
  return result;
}

export function resolveWorkerRpc(message: ParentMessage): boolean {
  if (message.type !== "rpc-result") return false;
  const waiter = pending.get(message.rpcId);
  if (!waiter) return true;
  pending.delete(message.rpcId);
  if (message.ok) waiter.resolve(message.value);
  else waiter.reject(reviveStickyError(message.error));
  return true;
}
