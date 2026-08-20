import { requestResult, runTransaction } from "./idb";
import { STORES } from "./schema";
import type { StoredPost } from "./model";
import { extentFiles } from "./files";
import { FileIds } from "./fileIds";
import { isImagePost, type PostEntity } from "@/shared/types/api";

export async function deletePostImageExtents(imageIds: readonly string[]): Promise<number> {
  let bytes = 0;
  for (const imageId of imageIds) {
    const deleted = await extentFiles.deletePrefix(FileIds.postImagePrefix(imageId));
    bytes += deleted.bytes;
  }
  return bytes;
}

/**
 * Thumbnail bytes are a reconstructible cache view. They must not participate
 * in post-revision identity, or a later ready/evicted thumb would collide.
 */
export function postEntityForRevisionCompare<T extends StoredPost | PostEntity>(
  post: T,
): T {
  if (!isImagePost(post)) return post;
  return {
    ...post,
    thumb: {
      state: "absent",
      mime: null,
      bytes: 0,
      width: 0,
      height: 0,
      sha256: null,
    },
  };
}

export function imageIdsFromPosts(posts: readonly StoredPost[]): string[] {
  const ids: string[] = [];
  for (const post of posts) {
    if (isImagePost(post)) ids.push(post.image_id);
  }
  return ids;
}

/** Drop post-image extents whose posts are no longer locally stored. */
export async function handlePostImageQuotaPressure(
  targetBytes: number,
): Promise<number> {
  const heads = await extentFiles.list("post-image:");
  const live = await runTransaction(STORES.POSTS, "readonly", async (tx) => {
    const posts = (await requestResult(
      tx.objectStore(STORES.POSTS).getAll(),
    )) as StoredPost[];
    return new Set(imageIdsFromPosts(posts));
  });
  heads.sort((left, right) => left.created_at - right.created_at);
  let freed = 0;
  const seen = new Set<string>();
  for (const head of heads) {
    if (freed >= targetBytes) break;
    const imageId = FileIds.postImageId(head.id);
    if (!imageId || live.has(imageId) || seen.has(imageId)) continue;
    seen.add(imageId);
    const deleted = await extentFiles.deletePrefix(FileIds.postImagePrefix(imageId));
    freed += deleted.bytes;
  }
  return freed;
}
