import { PublicError } from "@/server/services/incidentService";
import sharp from "sharp";

export const POST_IMAGE_MIME = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
export type PostImageMime = (typeof POST_IMAGE_MIME)[number];

export const THUMBNAIL_MAX_EDGE = 320;
export const THUMBNAIL_WEBP_QUALITY = 75;
export const THUMBNAIL_MIME = "image/webp";
const MAX_DECODE_PIXELS = 40_000_000;

export interface ImageInfo {
  mime: PostImageMime;
  width: number;
  height: number;
}

export interface ThumbnailBytes {
  mime: typeof THUMBNAIL_MIME;
  bytes: Uint8Array;
  width: number;
  height: number;
}

function header(bytes: Uint8Array, length: number): Buffer {
  return Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, length)));
}

export function detectPostImageMime(bytes: Uint8Array): PostImageMime | null {
  const prefix = header(bytes, 12);
  if (prefix.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) {
    return "image/jpeg";
  }
  if (prefix.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (
    prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
    prefix.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = readU16BE(bytes, offset + 2);
    if (length < 2) break;
    const sof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (sof && offset + 8 < bytes.byteLength) {
      return {
        height: readU16BE(bytes, offset + 5),
        width: readU16BE(bytes, offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new PublicError("无法读取 JPEG 尺寸");
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 24) throw new PublicError("PNG 文件过短");
  return {
    width: readU32BE(bytes, 16),
    height: readU32BE(bytes, 20),
  };
}

function gifDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 10) throw new PublicError("GIF 文件过短");
  return {
    width: readU16LE(bytes, 6),
    height: readU16LE(bytes, 8),
  };
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 30) throw new PublicError("WebP 文件过短");
  const fourcc = Buffer.from(bytes.subarray(12, 16)).toString("ascii");
  if (fourcc === "VP8X") {
    return {
      width: readU24LE(bytes, 24) + 1,
      height: readU24LE(bytes, 27) + 1,
    };
  }
  if (fourcc === "VP8 " && bytes.byteLength >= 30) {
    return {
      width: readU16LE(bytes, 26) & 0x3fff,
      height: readU16LE(bytes, 28) & 0x3fff,
    };
  }
  if (fourcc === "VP8L" && bytes.byteLength >= 25) {
    const bits =
      bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  throw new PublicError("无法读取 WebP 尺寸");
}

export function inspectPostImage(bytes: Uint8Array): ImageInfo {
  const mime = detectPostImageMime(bytes);
  if (!mime) throw new PublicError("不支持的图片格式");
  const size =
    mime === "image/jpeg"
      ? jpegDimensions(bytes)
      : mime === "image/png"
        ? pngDimensions(bytes)
        : mime === "image/gif"
          ? gifDimensions(bytes)
          : webpDimensions(bytes);
  if (size.width < 1 || size.height < 1) throw new PublicError("图片尺寸无效");
  if (size.width * size.height > MAX_DECODE_PIXELS) {
    throw new PublicError("图片分辨率过大");
  }
  return { mime, ...size };
}

/** True when both edges already fit the thumbnail bound. */
export function fitsThumbnailBound(width: number, height: number): boolean {
  return Math.max(width, height) <= THUMBNAIL_MAX_EDGE;
}

function copyIndependentBytes(data: Uint8Array): Uint8Array {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

function isUserImageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /unsupported image format|corrupt|Input buffer contains unsupported image format|Input file is missing|VipsJpeg|VipsPng|VipsWebP|gifload|limitInputPixels|exceeds pixel limit/i.test(
    error.message,
  );
}

/**
 * Rebuild a lossy WebP thumbnail from a decodable original. Sharp stays
 * outside the Vite SSR bundle so its platform `@img/sharp-*` addons remain
 * loadable; runtime-deps.mjs copies the target's prebuilds.
 */
export async function renderPostImageThumbnail(
  bytes: Uint8Array,
): Promise<ThumbnailBytes> {
  const info = inspectPostImage(bytes);
  if (!canRenderPostImageThumbnail(info.mime)) {
    throw new PublicError("暂不支持生成该格式的缩略图");
  }
  try {
    const rendered = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_DECODE_PIXELS,
      pages: 1,
      sequentialRead: true,
    })
      .rotate()
      .resize({
        width: THUMBNAIL_MAX_EDGE,
        height: THUMBNAIL_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({
        quality: THUMBNAIL_WEBP_QUALITY,
        effort: 4,
        smartSubsample: true,
      })
      .toBuffer({ resolveWithObject: true });
    return {
      mime: THUMBNAIL_MIME,
      bytes: copyIndependentBytes(rendered.data),
      width: rendered.info.width,
      height: rendered.info.height,
    };
  } catch (error) {
    if (error instanceof PublicError) throw error;
    if (isUserImageError(error)) throw new PublicError("无法生成缩略图");
    throw error;
  }
}

export function canRenderPostImageThumbnail(mime: PostImageMime): boolean {
  return (
    mime === "image/jpeg" ||
    mime === "image/png" ||
    mime === "image/gif" ||
    mime === "image/webp"
  );
}
