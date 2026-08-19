import type { MediaRuntime } from "@/server/runtime/mediaRuntime";
import type { ArticleImportRuntime } from "@/server/runtime/articleImportRuntime";
import type { TeachDocumentsRuntime } from "@/server/runtime/teachDocumentsRuntime";
import type { AiExecutionRuntime } from "@/server/runtime/aiExecutionRuntime";
import type { StickyCommand, StickyHost } from "@/server/runtime/sticky";
import {
  disabledUpdateStatus,
  type UpdateRuntime,
} from "@/server/runtime/update/runtime";
import { PublicError } from "@/server/services/incidentService";

function requireUpdate(runtime: UpdateRuntime | null): UpdateRuntime {
  if (!runtime) throw new PublicError("当前环境已禁用在线更新");
  return runtime;
}

export function createLiveStickyHost(input: {
  media: MediaRuntime;
  articleImports: ArticleImportRuntime;
  teachDocuments: TeachDocumentsRuntime;
  aiExecution: AiExecutionRuntime;
  update: UpdateRuntime | null;
  queueCommand: (command: StickyCommand) => void;
}): StickyHost {
  return {
    media: {
      available: input.media.available,
      search: (query, limit) =>
        input.media.search(query, limit, AbortSignal.timeout(40_000)),
      prepare: (track, kind) =>
        input.queueCommand({ type: "media.ensureMaterialized", track, kind }),
    },
    articleImports: {
      search: (userId, query) => input.articleImports.search(userId, query),
      start: (user, bookId, groupId, titleHint) =>
        Promise.resolve(
          input.articleImports.start(user, bookId, groupId, titleHint),
        ),
      list: (userId) => Promise.resolve(input.articleImports.list(userId)),
    },
    teachDocuments: {
      get monitorAvailable() {
        return input.teachDocuments.monitorAvailable;
      },
      evict: (id) => input.teachDocuments.evict(id),
    },
    ai: {
      abort: (runId) => input.aiExecution.abort(runId),
      abortUser: (userId) => input.aiExecution.abortUser(userId),
      execute: (payload) =>
        input.queueCommand({ type: "ai.execute", input: payload }),
    },
    update: {
      status: async () =>
        input.update
          ? { ...input.update.getStatus(), disabled: false }
          : disabledUpdateStatus(),
      cloudConfigChanged: () => input.update?.cloudConfigChanged(),
      checkCloud: async () => requireUpdate(input.update).checkCloudUpdate(),
      installCloud: async () =>
        requireUpdate(input.update).installCloudUpdate(),
      confirm: async () => {
        requireUpdate(input.update).confirmUpdate();
      },
      rollback: async () => {
        requireUpdate(input.update).requestRollback();
      },
      deploy: async (zipBytes) =>
        requireUpdate(input.update).deployUpdate(zipBytes),
    },
  };
}
