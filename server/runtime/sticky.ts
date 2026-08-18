import type { User } from "@/shared/types/api";
import type { MediaTrack } from "@/shared/media/types";
import type { AiModelsConfig } from "@/server/infra/aiModels";
import type { MediaSearchHit } from "@/server/runtime/mediaRuntime";
import type { ArticleImportTask } from "@/server/services/articleImportService";

/** Payload for a StickyRuntime AI execution. Cloneable across worker threads. */
export type AiExecuteInput = {
  user: User;
  runId: string;
  conversationId: string;
  originalLeaf: string | null;
  content: string;
  forkFromMessageId: string | null;
  hasImages: boolean;
  config: AiModelsConfig;
};

/** Fire-and-forget work that must run on the Coordinator after an Executor job commits. */
export type StickyCommand =
  | { type: "ai.execute"; input: AiExecuteInput }
  | {
      type: "media.ensureMaterialized";
      track: MediaTrack;
      kind: "audio" | "cover";
    };

export interface MediaSticky {
  readonly available: boolean;
  search(query: string, limit: number): Promise<MediaSearchHit[]>;
  prepare(track: MediaTrack, kind: "audio" | "cover"): void;
}

export interface ArticleImportSticky {
  search(
    userId: string,
    query: string,
  ): ReturnType<
    import("@/server/services/articleImportService").ArticleImportRuntime["search"]
  >;
  start(
    user: User,
    bookId: string,
    groupId: string,
    titleHint?: string,
  ): Promise<ArticleImportTask>;
  list(userId: string): Promise<ArticleImportTask[]>;
}

export interface TeachSticky {
  readonly monitorAvailable: boolean;
  evict(id: string): Promise<boolean>;
}

export interface AiSticky {
  abort(runId: string): void;
  abortUser(userId: string): void;
  execute(input: AiExecuteInput): void;
}

/** Sticky ports visible to a request Scope. None of these own a client connection. */
export interface StickyHost {
  readonly media: MediaSticky;
  readonly articleImports: ArticleImportSticky;
  readonly teachDocuments: TeachSticky;
  readonly ai: AiSticky;
}
