import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { BlobStore } from "@/server/storage/blobStore";
import { openExecutorDatabase } from "@/server/infra/db";
import { Scope, withScope, type RequestIdentity } from "@/server/runtime/scope";
import { createWorkerStickyHost, resolveWorkerRpc } from "@/server/runtime/workerSticky";
import { dispatchAction } from "@/server/protocol/registry";
import { ServerResultCodec } from "@/server/protocol/errorCodec";
import { withJobEvents, eventChannelsForUser } from "@/server/runtime/eventBus";
import { findUserBySessionToken } from "@/server/data/auth";
import { getUserBanStatus } from "@/server/data/users";
import { getClientIdFromToken } from "@/server/data/clients";
import { PublicError, ContractViolationError } from "@/server/services/incidentService";
import { runtimeConfig } from "@/server/infra/runtimeConfig";
import type {
  ExecutorJob,
  ExecutorJobResult,
  ExecutorWorkerData,
  ParentMessage,
  WorkerMessage,
} from "@/server/runtime/executorIpc";
import type { StickyCommand } from "@/server/runtime/sticky";

const payload = workerData as ExecutorWorkerData;
const db = openExecutorDatabase();
const blobs = new BlobStore(path.join(runtimeConfig().dataRoot, "storage"));

function send(message: WorkerMessage): void {
  parentPort!.postMessage(message);
}

async function runJob(job: ExecutorJob): Promise<ExecutorJobResult> {
  const commands: StickyCommand[] = [];
  const events: ExecutorJobResult["events"] = [];
  const sticky = createWorkerStickyHost({
    mediaAvailable: payload.mediaAvailable,
    teachMonitorAvailable: payload.teachMonitorAvailable,
    queueCommand: (command) => commands.push(command),
  });

  const outcome = await withJobEvents(
    async () => {
      if (job.kind === "authenticate") {
        return ServerResultCodec.capture(
          async () => authenticate(job.claimedUserId, job.token),
          { action: "remote.authenticate", userId: job.claimedUserId },
          db,
        );
      }
      const identity: RequestIdentity = job.identity;
      const scope = new Scope({ db, blobs, sticky, commands }, identity);
      return withScope(scope, () =>
        ServerResultCodec.capture(
          () => dispatchAction(job.action as never, job.args as never),
          { action: job.action, requestId: job.requestId, userId: identity.userId },
          db,
        ),
      );
    },
    (collected) => {
      events.push(...collected);
    },
  );

  return { id: job.id, events, commands, outcome };
}

function authenticate(claimedUserId: string, token: string) {
  const normalized = token.trim();
  const user = normalized ? findUserBySessionToken(db, normalized) : null;
  if (!user) throw new PublicError("会话认证失败");
  if (user.id !== claimedUserId) {
    throw new ContractViolationError("认证用户与 token 不匹配");
  }
  if (getUserBanStatus(db, user.id).banned) {
    throw new PublicError("当前用户已被封禁");
  }
  return {
    userId: user.id,
    clientId: getClientIdFromToken(db, normalized) ?? null,
    channels: eventChannelsForUser(db, user.id),
  };
}

parentPort!.on("message", (message: ParentMessage) => {
  if (resolveWorkerRpc(message)) return;
  if (message.type === "shutdown") {
    db.close();
    process.exit(0);
  }
  if (message.type !== "job") return;
      void runJob(message.job)
        .then((result) => send({ type: "done", result }))
        .catch(async (error: unknown) => {
          const outcome = await ServerResultCodec.capture(
            async () => {
              throw error;
            },
            {
              action:
                message.job.kind === "action"
                  ? message.job.action
                  : "remote.authenticate",
            },
            db,
          );
          send({
            type: "done",
            result: {
              id: message.job.id,
              events: [],
              commands: [],
              outcome,
            },
          });
        });
});

send({ type: "ready" });
