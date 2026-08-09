import type { ConvEventSpec, ConvUpdatedPayload } from "@/shared/types/events";
import type { Conversation } from "@/shared/types/api";
import type BetterSqlite3 from "better-sqlite3";
import {
  clearConversationComposeDraft,
  dmConversationExists,
  getConversationComposeDraftValue,
  getConversationEntry as getConversationEntryRecord,
  getConversationReadState,
  getConversationMutedState,
  getConversationPinnedState,
  getDmConversationPostRow,
  getGroupConversationPostRow,
  isGroupConversationMember,
  listConversations as listConversationEntries,
  listConversationGroupMemberIds,
  listConversationRevisions,
  listConversationParticipantIds,
  setConversationPinnedValue,
  setConversationMutedValue,
  upsertConversationComposeDraft,
  upsertConversationReadState,
  purgeConversationStateForUser,
} from "@/server/data/conversations";
import { publishUserConv } from "./eventBus";
import { ServiceError } from "./errors";
import { chooseFurthestRead } from "@/shared/sync/arbitration";
import { parseConvId } from "@/shared/conversations/id";

/**
 * Returns a single chronologically-sorted conversation list.
 *
 * The sidebar no longer separates groups and DMs — both flow into one list
 * sorted by most-recent activity (matching how chat clients usually work).
 * Callers may still partition by `type` if a sectioned view is desired.
 */
export function listConversations(
  db: BetterSqlite3.Database,
  userId: string,
): Conversation[] {
  return listConversationEntries(db, userId);
}

/** Fetch one sidebar row — used for incremental event push. */
export function getConversationEntry(
  db: BetterSqlite3.Database,
  userId: string,
  type: "group" | "dm",
  id: string,
): Conversation | null {
  return getConversationEntryRecord(db, userId, type, id);
}

/** Push a single sidebar delta over WebSocket instead of forcing a full refetch. */
export function publishConversationUpdate(
  db: BetterSqlite3.Database,
  userId: string,
  spec?: ConvEventSpec,
): void {
  if (spec && "removed" in spec && spec.removed) {
    publishUserConv(userId, {
      kind: "conv.updated",
      data: {
        removed: { type: spec.type, id: spec.id },
      } satisfies ConvUpdatedPayload,
    });
    return;
  }
  if (spec) {
    const entry = getConversationEntry(db, userId, spec.type, spec.id);
    if (entry) {
      publishUserConv(userId, {
        kind: "conv.updated",
        data: { entry } satisfies ConvUpdatedPayload,
      });
      return;
    }
    publishUserConv(userId, {
      kind: "conv.updated",
      data: {
        removed: { type: spec.type, id: spec.id },
      } satisfies ConvUpdatedPayload,
    });
    return;
  }
  publishUserConv(userId, {
    kind: "conv.updated",
    data: { refresh: true } satisfies ConvUpdatedPayload,
  });
}

/** Notify every participant whose sidebar row may have changed after a post mutation. */
export function publishConversationUpdateForPost(
  db: BetterSqlite3.Database,
  post: {
    conv_id: string;
  },
): void {
  const parsed = parseConvId(post.conv_id);
  if (parsed?.type === "group") {
    for (const userId of listConversationGroupMemberIds(db, parsed.groupId)) {
      publishConversationUpdate(db, userId, {
        type: "group",
        id: parsed.groupId,
      });
    }
  } else if (parsed?.type === "dm") {
    for (const userId of listConversationParticipantIds(db, post.conv_id)) {
      const peerId = parsed.peerA === userId ? parsed.peerB : parsed.peerA;
      publishConversationUpdate(db, userId, { type: "dm", id: peerId });
    }
  }
}

export function markConversationRead(
  db: BetterSqlite3.Database,
  userId: string,
  input: {
    type: "group" | "dm";
    id: string;
    postId: string;
    updatedAt: number;
    merge: "override" | "furthest";
  },
): { postId: string | null; sequence: number; updatedAt: number } {
  let targetPost: { id: string; rowid: number };
  if (input.type === "group") {
    if (!isGroupConversationMember(db, userId, input.id)) {
      throw new ServiceError("你不在该群组中", 403);
    }
    const post = getGroupConversationPostRow(db, {
      postId: input.postId,
      groupId: input.id,
    });
    if (!post) throw new ServiceError("帖子不存在", 404);
    targetPost = post;
  } else {
    const post = getDmConversationPostRow(db, {
      postId: input.postId,
      userId,
      partnerId: input.id,
    });
    if (!post) throw new ServiceError("帖子不存在", 404);
    targetPost = post;
  }

  const current = getConversationReadState(db, {
    userId,
    type: input.type,
    id: input.id,
  });
  const incoming = {
    postId: targetPost.id,
    sequence: targetPost.rowid,
    updatedAt: input.updatedAt,
  };
  const keepCurrent =
    input.merge === "furthest"
      ? chooseFurthestRead(current, incoming) === current
      : current.updatedAt > incoming.updatedAt;
  if (keepCurrent) {
    return current;
  }

  upsertConversationReadState(db, {
    userId,
    type: input.type,
    id: input.id,
    postId: input.postId,
    updatedAt: input.updatedAt,
  });
  publishConversationUpdate(db, userId, { type: input.type, id: input.id });
  return getConversationReadState(db, {
    userId,
    type: input.type,
    id: input.id,
  });
}

export function setConversationPinned(
  db: BetterSqlite3.Database,
  userId: string,
  input: {
    type: "group" | "dm";
    id: string;
    pinned: boolean;
    updatedAt: number;
  },
): { value: boolean; updatedAt: number } {
  if (input.type === "group") {
    if (!isGroupConversationMember(db, userId, input.id)) {
      throw new ServiceError("你不在该群组中", 403);
    }
  } else if (!dmConversationExists(db, userId, input.id)) {
    throw new ServiceError("对话不存在", 404);
  }

  setConversationPinnedValue(db, {
    userId,
    type: input.type,
    id: input.id,
    pinned: input.pinned,
    updatedAt: input.updatedAt,
  });
  publishConversationUpdate(db, userId, { type: input.type, id: input.id });
  return getConversationPinnedState(db, {
    userId,
    type: input.type,
    id: input.id,
  });
}

export function setConversationMuted(
  db: BetterSqlite3.Database,
  userId: string,
  input: {
    type: "group" | "dm";
    id: string;
    muted: boolean;
    updatedAt: number;
  },
): { value: boolean; updatedAt: number } {
  if (input.type === "group") {
    if (!isGroupConversationMember(db, userId, input.id)) {
      throw new ServiceError("你不在该群组中", 403);
    }
  } else if (!dmConversationExists(db, userId, input.id)) {
    throw new ServiceError("对话不存在", 404);
  }

  setConversationMutedValue(db, {
    userId,
    type: input.type,
    id: input.id,
    muted: input.muted,
    updatedAt: input.updatedAt,
  });
  publishConversationUpdate(db, userId, { type: input.type, id: input.id });
  return getConversationMutedState(db, {
    userId,
    type: input.type,
    id: input.id,
  });
}

function assertConversationAccess(
  db: BetterSqlite3.Database,
  userId: string,
  input: { type: "group" | "dm"; id: string },
): void {
  if (input.type === "group") {
    if (!isGroupConversationMember(db, userId, input.id)) {
      throw new ServiceError("你不在该群组中", 403);
    }
  } else if (!dmConversationExists(db, userId, input.id)) {
    throw new ServiceError("对话不存在", 404);
  }
}

export function getConversationComposeDraft(
  db: BetterSqlite3.Database,
  userId: string,
  input: { type: "group" | "dm"; id: string },
): { draft: string; updatedAt: number } {
  assertConversationAccess(db, userId, input);
  return getConversationComposeDraftValue(db, {
    userId,
    type: input.type,
    id: input.id,
  });
}

export function setConversationComposeDraft(
  db: BetterSqlite3.Database,
  userId: string,
  input: { type: "group" | "dm"; id: string; draft: string; updatedAt: number },
): void {
  assertConversationAccess(db, userId, input);

  const trimmed = input.draft.trim();
  if (!trimmed) {
    clearConversationComposeDraft(db, {
      userId,
      type: input.type,
      id: input.id,
      updatedAt: input.updatedAt,
    });
    return;
  }

  upsertConversationComposeDraft(db, {
    userId,
    type: input.type,
    id: input.id,
    draft: trimmed,
    updatedAt: input.updatedAt,
  });
}

// Backwards-compat alias: returns the same data split into groups/dms.
export function getConversations(
  db: BetterSqlite3.Database,
  userId: string,
): {
  groups: Conversation[];
  dms: Conversation[];
  entries: Conversation[];
} {
  const entries = listConversations(db, userId);
  return {
    entries,
    groups: entries.filter((e) => e.type === "group"),
    dms: entries.filter((e) => e.type === "dm"),
  };
}

export interface ConversationRefInput {
  type: "group" | "dm";
  id: string;
}

export class ConversationService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(userId: string): Conversation[] {
    return listConversations(this.db, userId);
  }

  revisions(userId: string): Array<{ conv_id: string; revision: number }> {
    return listConversationRevisions(this.db, userId);
  }

  markRead(
    userId: string,
    input: ConversationRefInput & {
      postId: string;
      updatedAt: number;
      merge: "override" | "furthest";
    },
  ): { postId: string | null; sequence: number; updatedAt: number } {
    return markConversationRead(this.db, userId, input);
  }

  setPinned(
    userId: string,
    input: ConversationRefInput & { pinned: boolean; updatedAt: number },
  ): { value: boolean; updatedAt: number } {
    return setConversationPinned(this.db, userId, input);
  }

  setMuted(
    userId: string,
    input: ConversationRefInput & { muted: boolean; updatedAt: number },
  ): { value: boolean; updatedAt: number } {
    return setConversationMuted(this.db, userId, input);
  }

  getDraft(
    userId: string,
    input: ConversationRefInput,
  ): { draft: string; updatedAt: number } {
    return getConversationComposeDraft(this.db, userId, input);
  }

  saveDraft(
    userId: string,
    input: ConversationRefInput & { draft: string; updatedAt: number },
  ): { draft: string; updatedAt: number } {
    setConversationComposeDraft(this.db, userId, input);
    return getConversationComposeDraft(this.db, userId, input);
  }

  purgeUser(userId: string): void {
    purgeConversationStateForUser(this.db, userId);
  }
}

export function createConversationService(
  db: BetterSqlite3.Database,
): ConversationService {
  return new ConversationService(db);
}
