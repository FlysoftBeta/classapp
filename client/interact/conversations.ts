import { observeActionResult } from "@/client/api/runtime";
import type { ConvEntry } from "@/client/interact/types";
const {
  fetchConversationDraftAction,
  fetchConversationRevisionsAction,
  fetchConversationsAction,
  markConversationReadAction,
  saveConversationDraftAction,
  setConversationMutedAction,
  setConversationPinnedAction,
} = client.actions;
import { client } from "@/client/interact/remote/client";
import { ResultTools } from "@/shared/protocol/result";
import { offlineRepository } from "@/client/data/repository";
import { collectRevisionRange } from "@/client/interact/consistency";
import {
  commitPostRevisionRange,
  fetchRemotePosts,
} from "@/client/interact/posts";

export async function syncConversationPostRevisions(): Promise<void> {
  const cached = await offlineRepository.getConversations();
  if (!cached.length) return;
  const result = await fetchConversationRevisionsAction();
  observeActionResult(result);
  if (!result.ok) return;
  for (const remote of result.data.revisions) {
    const conversation = cached.find(
      (entry) => entry.conv_id === remote.conv_id,
    );
    if (!conversation) continue;
    const knownRevision = await offlineRepository.getKnownPostRevision(
      remote.conv_id,
    );
    if (remote.revision <= knownRevision) continue;
    const rows = await collectRevisionRange(
      knownRevision,
      remote.revision,
      async (cursor, through, limit) => {
        const page = await fetchRemotePosts(conversation, {
          changed_after_revision: String(cursor),
          changed_through_revision: String(through),
          limit: String(limit),
        });
        if (!page) throw new Error(`Failed to synchronize ${remote.conv_id}`);
        return page.posts;
      },
    );
    await commitPostRevisionRange(conversation, rows, remote.revision);
  }
}

export async function fetchConversationAccess(): Promise<ConvEntry[]> {
  if (!client.isConnected()) return offlineRepository.getConversations();
  const result = await fetchConversationsAction();
  observeActionResult(result);
  if (!result.ok) return offlineRepository.getConversations();
  await offlineRepository.saveConversations(result.data);
  return sortConversations(await offlineRepository.getConversations());
}

function sortConversations(entries: ConvEntry[]): ConvEntry[] {
  return entries.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return b.pinned - a.pinned;
    if (a.last_at && b.last_at) return b.last_at.localeCompare(a.last_at);
    if (a.last_at) return -1;
    if (b.last_at) return 1;
    return a.name.localeCompare(b.name);
  });
}

export async function fetchConversations(): Promise<ConvEntry[]> {
  if (!client.isConnected()) return offlineRepository.getConversations();
  try {
    const entries = await fetchConversationAccess();
    await syncConversationPostRevisions();
    return entries;
  } catch {
    return offlineRepository.getConversations();
  }
}

export async function markConversationRead(body: {
  type: "group" | "dm";
  id: string;
  post_id: string;
}) {
  const ref = { type: body.type, id: body.id };
  const cachedPost = (await offlineRepository.getPosts(ref)).find(
    (post) => post.id === body.post_id,
  );
  const local = await offlineRepository.setPendingConversationRead(
    ref,
    body.post_id,
    cachedPost?.sequence,
    !client.isConnected(),
  );
  const localResult = () =>
    ResultTools.ok(
      {
        postId: local.version.value.postId,
        sequence: local.version.value.sequence,
        updatedAt: local.version.updatedAt,
      },
      { buildId: client.buildId },
    );
  if (!local.changed || !client.isConnected()) return localResult();
  try {
    const result = await markConversationReadAction({
      ...body,
      updatedAt: local.version.updatedAt,
      merge: "override",
    });
    const response = observeActionResult(result);
    if (result.ok) {
      await offlineRepository.reconcileConversationRead(ref, result.data);
    }
    return response;
  } catch {
    return localResult();
  }
}

export async function setConversationPinned(body: {
  type: "group" | "dm";
  id: string;
  pinned: boolean;
}) {
  const local = await offlineRepository.setConversationFlag(
    body,
    "pinned",
    body.pinned,
  );
  const localResult = () =>
    ResultTools.ok(
      { value: local.value, updatedAt: local.updatedAt },
      { buildId: client.buildId },
    );
  if (!client.isConnected()) return localResult();
  try {
    const result = await setConversationPinnedAction({
      ...body,
      updatedAt: local.updatedAt,
    });
    const response = observeActionResult(result);
    if (result.ok) {
      await offlineRepository.reconcileConversationFlag(
        body,
        "pinned",
        result.data,
      );
    }
    return response;
  } catch {
    return localResult();
  }
}

export async function setConversationMuted(body: {
  type: "group" | "dm";
  id: string;
  muted: boolean;
}) {
  const local = await offlineRepository.setConversationFlag(
    body,
    "muted",
    body.muted,
  );
  const localResult = () =>
    ResultTools.ok(
      { value: local.value, updatedAt: local.updatedAt },
      { buildId: client.buildId },
    );
  if (!client.isConnected()) return localResult();
  try {
    const result = await setConversationMutedAction({
      ...body,
      updatedAt: local.updatedAt,
    });
    const response = observeActionResult(result);
    if (result.ok) {
      await offlineRepository.reconcileConversationFlag(
        body,
        "muted",
        result.data,
      );
    }
    return response;
  } catch {
    return localResult();
  }
}

export async function syncPendingConversationConfig() {
  if (!client.isConnected()) return;
  for (const mutation of await offlineRepository.getPendingConversationMutations()) {
    const { ref, field, updatedAt } = mutation;
    try {
      if (field === "muted" || field === "pinned") {
        const desired = mutation.value as boolean;
        const result =
          field === "muted"
            ? await setConversationMutedAction({
                type: ref.type,
                id: ref.id,
                muted: desired,
                updatedAt,
              })
            : await setConversationPinnedAction({
                type: ref.type,
                id: ref.id,
                pinned: desired,
                updatedAt,
              });
        observeActionResult(result);
        if (result.ok) {
          await offlineRepository.reconcileConversationFlag(
            ref,
            field,
            result.data,
          );
        }
      } else if (field === "read") {
        const read = mutation.value as {
          postId: string | null;
          sequence: number;
        };
        const postId = read.postId;
        if (!postId) continue;
        const result = await markConversationReadAction({
          type: ref.type,
          id: ref.id,
          post_id: postId,
          updatedAt,
          merge: "furthest",
        });
        observeActionResult(result);
        if (result.ok) {
          await offlineRepository.reconcileConversationRead(
            ref,
            result.data,
            "furthest",
          );
        }
      } else continue;
    } catch {
      /* retry on reconnect */
    }
  }
}

export async function fetchConversationDraft(query: {
  type: "group" | "dm";
  id: string;
}): Promise<string> {
  const local = await offlineRepository.getDraft(query);
  if (!client.isConnected()) return local?.content ?? "";
  try {
    if (local && local.syncedAt === null) {
      const result = await saveConversationDraftAction({
        ...query,
        draft: local.content,
        updatedAt: local.updatedAt,
      });
      observeActionResult(result);
      if (result.ok) {
        const canonical = result.data;
        await offlineRepository.saveDraft(query, canonical.draft, {
          updatedAt: canonical.updatedAt,
          synced: true,
        });
        return canonical.draft;
      }
      return local.content;
    }
    const result = await fetchConversationDraftAction(query);
    observeActionResult(result);
    const remote = result.ok
      ? result.data
      : { draft: local?.content ?? "", updatedAt: local?.updatedAt ?? 0 };
    if (local && local.updatedAt > remote.updatedAt) return local.content;
    await offlineRepository.saveDraft(query, remote.draft ?? "", {
      updatedAt: remote.updatedAt,
      synced: true,
    });
    return remote.draft ?? "";
  } catch {
    return local?.content ?? "";
  }
}

export async function saveConversationDraft(body: {
  type: "group" | "dm";
  id: string;
  draft: string;
}) {
  const local = await offlineRepository.saveDraft(body, body.draft);
  const localResult = () =>
    ResultTools.ok(
      { draft: local.content, updatedAt: local.updatedAt },
      { buildId: client.buildId },
    );
  if (!client.isConnected()) return localResult();
  try {
    const result = await saveConversationDraftAction({
      ...body,
      updatedAt: local.updatedAt,
    });
    const response = observeActionResult(result);
    if (result.ok)
      await offlineRepository.saveDraft(body, result.data.draft, {
        updatedAt: result.data.updatedAt,
        synced: true,
      });
    return response;
  } catch {
    return localResult();
  }
}
