import { extentFiles } from "@/client/data/files";
import { FileIds } from "@/client/data/fileIds";
import { apiFetch, authHeaders, parseJson } from "@/client/api/runtime";
import { session } from "@/client/interact/remote/session";
import { materializePost, type PostMutationData } from "@/client/interact/posts";
import { currentActorRepository as offlineRepository } from "@/client/interact/actorContext";
import { captureDetachedClientIncident } from "@/client/interact/clientIncidents";
import { recoverFromQuotaExceeded } from "@/client/interact/quota";
import type { Post } from "@/client/interact/presentation";
import type { ImagePostEntity, UserMetadata } from "@/shared/types/api";
import { isImagePost } from "@/shared/types/api";

function readFileBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("无法读取图片"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("无法读取图片"));
    reader.readAsArrayBuffer(file);
  });
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function publishExtent(
  id: string,
  buffer: ArrayBuffer,
  expectedSha: string | null,
): Promise<void> {
  const digest = await sha256Hex(buffer);
  if (expectedSha && digest !== expectedSha) {
    throw new Error("图片校验失败");
  }
  await recoverFromQuotaExceeded(() =>
    extentFiles.replace(id, buffer.byteLength, buffer, digest),
  );
}

async function readExtent(id: string, expectedBytes?: number): Promise<ArrayBuffer | null> {
  const cached = await extentFiles.readAll(id).catch(() => null);
  if (!cached) return null;
  if (expectedBytes !== undefined && cached.byteLength !== expectedBytes) return null;
  return cached;
}

async function fetchImageBytes(path: string): Promise<ArrayBuffer> {
  const response = await apiFetch(path, {
    headers: authHeaders(session.getToken()),
  });
  if (!response.ok) {
    throw new Error(`图片请求失败：HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

export async function cachePostImageOriginal(
  imageId: string,
  buffer: ArrayBuffer,
  sha256: string,
): Promise<void> {
  await publishExtent(FileIds.postImageOriginal(imageId), buffer, sha256);
}

export async function loadPostImageThumb(
  image: Pick<ImagePostEntity, "image_id" | "thumb">,
): Promise<ArrayBuffer | null> {
  const fileId = FileIds.postImageThumb(image.image_id);
  const cached = await readExtent(
    fileId,
    image.thumb.state === "ready" ? image.thumb.bytes : undefined,
  );
  if (cached) return cached;
  try {
    const buffer = await fetchImageBytes(
      `/api/posts/images/${encodeURIComponent(image.image_id)}/thumb`,
    );
    if (image.thumb.sha256) {
      await publishExtent(fileId, buffer, image.thumb.sha256).catch((error) => {
        captureDetachedClientIncident("post-image.thumb-cache", error);
      });
    } else {
      await publishExtent(fileId, buffer, null).catch((error) => {
        captureDetachedClientIncident("post-image.thumb-cache", error);
      });
    }
    return buffer;
  } catch (error) {
    captureDetachedClientIncident("post-image.thumb-fetch", error);
    return null;
  }
}

export async function loadPostImageOriginal(
  image: Pick<ImagePostEntity, "image_id" | "bytes" | "sha256">,
): Promise<ArrayBuffer | null> {
  const fileId = FileIds.postImageOriginal(image.image_id);
  const cached = await readExtent(fileId, image.bytes);
  if (cached) return cached;
  try {
    const buffer = await fetchImageBytes(
      `/api/posts/images/${encodeURIComponent(image.image_id)}/original`,
    );
    await publishExtent(fileId, buffer, image.sha256).catch((error) => {
      captureDetachedClientIncident("post-image.original-cache", error);
    });
    return buffer;
  } catch (error) {
    captureDetachedClientIncident("post-image.original-fetch", error);
    return null;
  }
}

export async function deletePostImageFiles(imageId: string): Promise<number> {
  const deleted = await extentFiles.deletePrefix(FileIds.postImagePrefix(imageId));
  return deleted.bytes;
}

export async function uploadPostImage(body: {
  file: File;
  conv_id: string;
  reply_to?: string | null;
}): Promise<{ res: { ok: boolean }; data: PostMutationData }> {
  const form = new FormData();
  form.set("file", body.file);
  form.set("conv_id", body.conv_id);
  if (body.reply_to) form.set("reply_to", body.reply_to);
  const localBytes = await readFileBuffer(body.file);
  const res = await apiFetch("/api/posts/images", {
    method: "POST",
    headers: authHeaders(session.getToken()),
    body: form,
  });
  const payload = await parseJson<{
    post?: ImagePostEntity;
    users?: UserMetadata[];
    error?: string;
  }>(res);
  if (!res.ok || !payload.post || !payload.users) {
    return {
      res,
      data: { error: payload.error || "发送图片失败" },
    };
  }
  const post = materializePost(payload.post, payload.users) as Post;
  try {
    await offlineRepository.saveUserMetadata(payload.users);
    if (isImagePost(post)) {
      await cachePostImageOriginal(post.image_id, localBytes, post.sha256);
    }
  } catch (error) {
    captureDetachedClientIncident("post-image.upload-cache", error);
  }
  return { res, data: { post, users: payload.users } };
}
