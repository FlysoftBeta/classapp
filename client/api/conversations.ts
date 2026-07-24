import { observeActionResult } from "./runtime";
import type { ConvEntry } from "@/client/app/appReducer";
const {
  fetchConversationDraftAction,
  fetchConversationsAction,
  markConversationReadAction,
  saveConversationDraftAction,
  setConversationMutedAction,
  setConversationPinnedAction,
} = client.actions;
import { client } from "@/client/lib/remote/client";
import { ResultTools } from "@/shared/protocol/result";
import { offlineRepository } from "@/client/resource/offlineRepository";

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
    const result = await fetchConversationsAction();
    observeActionResult(result);
    if (!result.ok) return offlineRepository.getConversations();
    const entries = result.data;
    for (const entry of entries) {
      const ref = { type: entry.type, id: entry.id };
      const muted = await offlineRepository.reconcileVersionedValue(
        "conversation-config",
        `${entry.type}:${entry.id}:muted`,
        {
          value: !!entry.muted,
          updatedAt: entry.muted_updated_at_ms,
        },
      );
      entry.muted = muted.value ? 1 : 0;
      entry.muted_updated_at_ms = muted.updatedAt;

      const pinned = await offlineRepository.reconcileVersionedValue(
        "conversation-config",
        `${entry.type}:${entry.id}:pinned`,
        {
          value: !!entry.pinned,
          updatedAt: entry.pinned_updated_at_ms,
        },
      );
      entry.pinned = pinned.value ? 1 : 0;
      entry.pinned_updated_at_ms = pinned.updatedAt;

      const read = await offlineRepository.reconcileConversationRead(ref, {
        postId: entry.last_read_post_id,
        sequence: entry.last_read_post_sequence,
        updatedAt: entry.read_updated_at_ms,
      });
      if (read.value.sequence > entry.last_read_post_sequence) {
        entry.last_read_post_id = read.value.postId;
        entry.last_read_post_sequence = read.value.sequence;
        entry.read_updated_at_ms = read.updatedAt;
        entry.first_unread_post_id = null;
        entry.unread_count = 0;
      }
    }
    const sorted = sortConversations(entries);
    await offlineRepository.saveConversations(sorted);
    return sorted;
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
  const id = `${body.type}:${body.id}:pinned`;
  const local = await offlineRepository.setVersionedValue(
    "conversation-config",
    id,
    body.pinned,
  );
  const entries = await offlineRepository.getConversations();
  const entry = entries.find(
    (item) => item.type === body.type && item.id === body.id,
  );
  if (entry) {
    await offlineRepository.upsertConversation({
      ...entry,
      pinned: body.pinned ? 1 : 0,
      pinned_updated_at_ms: local.updatedAt,
    });
  }
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
      await offlineRepository.reconcileVersionedValue(
        "conversation-config",
        id,
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
  const id = `${body.type}:${body.id}:muted`;
  const local = await offlineRepository.setVersionedValue(
    "conversation-config",
    id,
    body.muted,
  );
  const entries = await offlineRepository.getConversations();
  const entry = entries.find(
    (item) => item.type === body.type && item.id === body.id,
  );
  if (entry)
    await offlineRepository.upsertConversation({
      ...entry,
      muted: body.muted ? 1 : 0,
      muted_updated_at_ms: local.updatedAt,
    });
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
      await offlineRepository.reconcileVersionedValue(
        "conversation-config",
        id,
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
  for (const {
    id,
    version,
  } of await offlineRepository.getPendingVersionedValues<unknown>(
    "conversation-config",
  )) {
    const [type, conversationId, field] = id.split(":");
    if ((type !== "group" && type !== "dm") || !conversationId) continue;
    try {
      if (field === "muted" || field === "pinned") {
        const desired = !!version.value;
        const result =
          field === "muted"
            ? await setConversationMutedAction({
                type,
                id: conversationId,
                muted: desired,
                updatedAt: version.updatedAt,
              })
            : await setConversationPinnedAction({
                type,
                id: conversationId,
                pinned: desired,
                updatedAt: version.updatedAt,
              });
        observeActionResult(result);
        if (result.ok) {
          await offlineRepository.reconcileVersionedValue(
            "conversation-config",
            id,
            result.data,
          );
        }
      } else if (field === "read") {
        const read = await offlineRepository.getConversationReadVersion({
          type,
          id: conversationId,
        });
        const postId = read?.value.postId;
        if (!postId) continue;
        const result = await markConversationReadAction({
          type,
          id: conversationId,
          post_id: postId,
          updatedAt: read.updatedAt,
        });
        observeActionResult(result);
        if (result.ok) {
          await offlineRepository.reconcileConversationRead(
            { type, id: conversationId },
            result.data,
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
