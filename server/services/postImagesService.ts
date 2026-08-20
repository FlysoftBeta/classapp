import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import type { BlobRead } from "@/server/storage/blobStore";
import { BlobStore } from "@/server/storage/blobStore";
import {
  QuotaService,
  type QuotaItem,
  type QuotaPoolPolicy,
} from "@/server/storage/quotaService";
import { PublicError } from "@/server/services/incidentService";
import { bytes, formatBytes } from "@/shared/bytes";
import {
  attachPostImage,
  deleteStagingPostImage,
  detachPostImage,
  evictThumb,
  getPostImage,
  insertStagingPostImage,
  listDeletedPostImages,
  listStaleStagingPostImages,
  markThumbFailed,
  markThumbStaging,
  publishThumb,
  type PostImageRecord,
} from "@/server/data/postImages";
import {
  detectPostImageMime,
  inspectPostImage,
  renderPostImageThumbnail,
} from "@/server/infra/imageThumbnail";

export const POST_IMAGE_POOL = "post-images";
export const POST_IMAGE_THUMB_POOL = "post-image-thumbs";
export const MAX_POST_IMAGE_BYTES = bytes("12 MB");
const THUMB_POOL_MAX_BYTES = bytes("512 MB");
const HALF_LIFE_MS = 7 * 24 * 60 * 60_000;
const ADMISSION_PIN_MS = 10 * 60_000;
const STAGING_TTL_MINUTES = 30;
const MAX_ORIGINAL_READ = MAX_POST_IMAGE_BYTES;

export interface IngestedPostImage {
  id: string;
  blobId: string;
  mime: PostImageMime;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
}

function sha256Hex(payload: Uint8Array): string {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function declaredMime(file: File): string {
  const type = file.type.trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  return type;
}

export class PostImageService {
  private readonly quota = new QuotaService(this.db);

  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
  ) {}

  quotaThumbPolicy(): QuotaPoolPolicy {
    return {
      name: POST_IMAGE_THUMB_POOL,
      maxWeight: THUMB_POOL_MAX_BYTES,
      targetRatio: 0.8,
      halfLifeMs: HALF_LIFE_MS,
    };
  }

  ensureQuotaPools(): void {
    this.quota.configure({
      name: POST_IMAGE_POOL,
      maxWeight: 0,
      targetRatio: 0.8,
      halfLifeMs: HALF_LIFE_MS,
    });
    this.quota.configure(this.quotaThumbPolicy());
  }

  async ingest(file: File): Promise<IngestedPostImage> {
    if (!file.size) throw new PublicError("图片不能为空");
    if (file.size > MAX_POST_IMAGE_BYTES) {
      throw new PublicError(`图片不能超过 ${formatBytes(MAX_POST_IMAGE_BYTES)}`);
    }
    const declared = declaredMime(file);
    if (declared && !declared.startsWith("image/")) {
      throw new PublicError("请选择图片文件");
    }
    const payload = new Uint8Array(await file.arrayBuffer());
    if (payload.byteLength !== file.size) {
      throw new PublicError("图片读取不完整");
    }
    const detected = detectPostImageMime(payload);
    if (!detected) throw new PublicError("不支持的图片格式");
    if (
      declared &&
      declared !== "image/*" &&
      declared !== detected &&
      !(declared === "image/jpg" && detected === "image/jpeg")
    ) {
      throw new PublicError("图片类型与文件内容不匹配");
    }
    const info = inspectPostImage(payload);
    const id = crypto.randomUUID();
    const digest = sha256Hex(payload);
    const slot = await this.blobs.create();
    insertStagingPostImage(this.db, {
      id,
      blobId: slot.id,
      mime: info.mime,
      bytes: payload.byteLength,
      width: info.width,
      height: info.height,
      sha256: digest,
    });
    try {
      await this.blobs.writeSlot(slot, payload, payload.byteLength);
      const committed = await slot.commit({ expectedBytes: payload.byteLength });
      return {
        id,
        blobId: committed.id,
        mime: info.mime,
        bytes: committed.bytes,
        width: info.width,
        height: info.height,
        sha256: digest,
      };
    } catch (error) {
      await slot.discard();
      await this.blobs.drop(slot.id).catch(() => undefined);
      deleteStagingPostImage(this.db, id);
      throw error;
    }
  }

  attach(imageId: string, postId: string): void {
    this.ensureQuotaPools();
    const image = getPostImage(this.db, imageId);
    if (!image) throw new PublicError("图片不存在");
    if (!attachPostImage(this.db, imageId, postId)) {
      throw new PublicError("图片上传已失效");
    }
    this.quota.account(POST_IMAGE_POOL, imageId, {
      weight: image.bytes,
      class: "durable",
    });
  }

  async abandon(imageId: string): Promise<void> {
    const blobId = deleteStagingPostImage(this.db, imageId);
    if (blobId) await this.blobs.drop(blobId).catch(() => undefined);
  }

  lookup(imageId: string): PostImageRecord | null {
    return getPostImage(this.db, imageId);
  }

  get(imageId: string): PostImageRecord {
    const image = getPostImage(this.db, imageId);
    if (!image || !image.postId) throw new PublicError("图片不存在");
    return image;
  }

  touchThumb(imageId: string): void {
    this.ensureQuotaPools();
    this.quota.touch(POST_IMAGE_THUMB_POOL, imageId, 1);
  }

  beginThumbMaterialization(imageId: string) {
    const image = this.get(imageId);
    if (image.thumb.state === "ready" && image.thumb.blobId) {
      this.touchThumb(imageId);
      return { kind: "ready" as const, image };
    }
    if (image.thumb.state === "staging") {
      return { kind: "pending" as const, image };
    }
    const thumb = markThumbStaging(this.db, imageId);
    if (!thumb) return { kind: "pending" as const, image: this.get(imageId) };
    return {
      kind: "start" as const,
      image: this.get(imageId),
      generation: thumb.generation,
    };
  }

  async materializeThumb(imageId: string, generation: number): Promise<boolean> {
    const image = getPostImage(this.db, imageId);
    if (!image) return false;
    const original = await this.blobs.read(image.blobId, MAX_ORIGINAL_READ);
    let thumbBytes: Uint8Array;
    let mime: string;
    let width: number;
    let height: number;
    try {
      const rendered = await renderPostImageThumbnail(original);
      thumbBytes = rendered.bytes;
      mime = rendered.mime;
      width = rendered.width;
      height = rendered.height;
    } catch (error) {
      markThumbFailed(this.db, imageId, generation);
      throw error;
    }
    const slot = await this.blobs.create();
    try {
      await this.blobs.writeSlot(slot, thumbBytes, thumbBytes.byteLength);
      const committed = await slot.commit({
        expectedBytes: thumbBytes.byteLength,
      });
      const published = this.db.transaction(() =>
        publishThumb(this.db, imageId, generation, {
          blobId: committed.id,
          mime,
          bytes: committed.bytes,
          width,
          height,
          sha256: sha256Hex(thumbBytes),
        }),
      )();
      if (!published) {
        await this.blobs.drop(committed.id).catch(() => undefined);
        return false;
      }
      this.ensureQuotaPools();
      this.quota.account(POST_IMAGE_THUMB_POOL, imageId, {
        weight: committed.bytes,
        class: "cache",
        pinUntilMs: Date.now() + ADMISSION_PIN_MS,
      });
      return true;
    } catch (error) {
      await slot.discard();
      await this.blobs.drop(slot.id).catch(() => undefined);
      markThumbFailed(this.db, imageId, generation);
      throw error;
    }
  }

  failThumb(imageId: string, generation: number): void {
    markThumbFailed(this.db, imageId, generation);
  }

  async openOriginal(
    imageId: string,
  ): Promise<{ image: PostImageRecord; read: BlobRead }> {
    const image = this.get(imageId);
    return { image, read: await this.blobs.open(image.blobId) };
  }

  async openThumb(
    imageId: string,
  ): Promise<{ image: PostImageRecord; read: BlobRead } | null> {
    const image = this.get(imageId);
    if (image.thumb.state !== "ready" || !image.thumb.blobId) return null;
    this.touchThumb(imageId);
    return { image, read: await this.blobs.open(image.thumb.blobId) };
  }

  async evictThumb(imageId: string, snapshot?: QuotaItem): Promise<boolean> {
    const image = getPostImage(this.db, imageId);
    if (!image) {
      this.quota.release(POST_IMAGE_THUMB_POOL, imageId, snapshot);
      return true;
    }
    const blobId = this.db.transaction(() =>
      evictThumb(this.db, imageId, image.thumb.generation),
    )();
    if (!blobId) return false;
    await this.blobs.drop(blobId);
    this.quota.release(POST_IMAGE_THUMB_POOL, imageId, snapshot);
    return true;
  }

  async reclaim(image: PostImageRecord): Promise<void> {
    const detached = this.db.transaction(() =>
      detachPostImage(this.db, image.id),
    )();
    if (!detached) return;
    await this.blobs.drop(detached.originalBlobId).catch(() => undefined);
    if (detached.thumbBlobId) {
      await this.blobs.drop(detached.thumbBlobId).catch(() => undefined);
    }
    this.quota.release(POST_IMAGE_POOL, image.id);
    this.quota.release(POST_IMAGE_THUMB_POOL, image.id);
  }

  async reconcile(): Promise<number> {
    const olderThan = new Date(Date.now() - STAGING_TTL_MINUTES * 60_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    let reclaimed = 0;
    for (const image of listStaleStagingPostImages(this.db, olderThan)) {
      await this.abandon(image.id);
      reclaimed += 1;
    }
    for (const image of listDeletedPostImages(this.db)) {
      await this.reclaim(image);
      reclaimed += 1;
    }
    return reclaimed;
  }
}

export function createPostImageService(
  db: Database,
  blobs: BlobStore,
): PostImageService {
  return new PostImageService(db, blobs);
}
