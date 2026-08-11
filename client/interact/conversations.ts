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
import { currentActorRepository as offlineRepository } from "@/client/interact/actorContext";
import { collectRevisionRange } from "@/client/interact/consistency";
import {
  commitPostRevisionRange,
  fetchRemotePosts,
} from "@/client/interact/posts";
import { captureDetachedClientIncident } from "@/client/interact/clientIncidents";

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
    const knownRevisionSum = await offlineRepository.getKnownPostRevisionSum(
      remote.conv_id,
    );
    // The sum is the cheap change detector; the monotonic revision remains the
    // cursor used to transfer only changed rows.
    if (knownRevisionSum === remote.revision_sum) continue;
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
    await commitPostRevisionRange(
      conversation,
      rows,
      remote.revision,
      remote.revision_sum,
    );
  }
}

export async function fetchConversationAccess(): Promise<ConvEntry[]> {
  if (!client.isConnected()) return offlineRepository.getConversations();
  const result = await fetchConversationsAction();
  observeActionResult(result);
  if (!result.ok) return offlineRepository.getConversations();
  try {
    await offlineRepository.saveConversations(result.data);
    return sortConversations(await offlineRepository.getConversations());
  } catch (error) {
    captureDetachedClientIncident("conversation.snapshot-cache", error);
    return sortConversations([...result.data]);
  }
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
  const entries = await fetchConversationAccess();
  try {
    await syncConversationPostRevisions();
  } catch (error) {
    // Revision recovery is secondary to the valid access snapshot.
    captureDetachedClientIncident("conversation.revision-recovery", error);
  }
  return entries;
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
  const result = await markConversationReadAction({
    ...body,
    updatedAt: local.version.updatedAt,
    merge: "override",
  });
  const response = observeActionResult(result);
  if (result.ok) {
    try {
      await offlineRepository.reconcileConversationRead(ref, result.data);
    } catch (error) {
      captureDetachedClientIncident("conversation.read-marker-cache", error);
    }
  }
  return response;
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
  const result = await setConversationPinnedAction({
    ...body,
    updatedAt: local.updatedAt,
  });
  const response = observeActionResult(result);
  if (result.ok) {
    try {
      await offlineRepository.reconcileConversationFlag(
        body,
        "pinned",
        result.data,
      );
    } catch (error) {
      captureDetachedClientIncident("conversation.pin-cache", error);
    }
  }
  return response;
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
  const result = await setConversationMutedAction({
    ...body,
    updatedAt: local.updatedAt,
  });
  const response = observeActionResult(result);
  if (result.ok) {
    try {
      await offlineRepository.reconcileConversationFlag(
        body,
        "muted",
        result.data,
      );
    } catch (error) {
      captureDetachedClientIncident("conversation.mute-cache", error);
    }
  }
  return response;
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
    } catch (error) {
      captureDetachedClientIncident("conversation.pending-mutation", error);
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
  if (local && local.syncedAt === null) {
    const result = await saveConversationDraftAction({
      ...query,
      draft: local.content,
      updatedAt: local.updatedAt,
    });
    observeActionResult(result);
    if (result.ok) {
      const canonical = result.data;
      try {
        await offlineRepository.saveDraft(query, canonical.draft, {
          updatedAt: canonical.updatedAt,
          synced: true,
        });
      } catch (error) {
        captureDetachedClientIncident("conversation.draft-cache", error);
      }
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
  try {
    await offlineRepository.saveDraft(query, remote.draft ?? "", {
      updatedAt: remote.updatedAt,
      synced: true,
    });
  } catch (error) {
    captureDetachedClientIncident("conversation.draft-cache", error);
  }
  return remote.draft ?? "";
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
  const result = await saveConversationDraftAction({
    ...body,
    updatedAt: local.updatedAt,
  });
  const response = observeActionResult(result);
  if (result.ok) {
    try {
      await offlineRepository.saveDraft(body, result.data.draft, {
        updatedAt: result.data.updatedAt,
        synced: true,
      });
    } catch (error) {
      captureDetachedClientIncident("conversation.draft-cache", error);
    }
  }
  return response;
}
