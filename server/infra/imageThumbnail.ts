import { PublicError } from "@/server/services/incidentService";
import jpegJs from "jpeg-js";
import { GifReader } from "omggif";
import { PNG } from "pngjs";

export const POST_IMAGE_MIME = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
export type PostImageMime = (typeof POST_IMAGE_MIME)[number];

export const THUMBNAIL_MAX_EDGE = 320;
export const THUMBNAIL_JPEG_QUALITY = 72;
export const THUMBNAIL_MIME = "image/jpeg";
const MAX_DECODE_PIXELS = 40_000_000;

interface JpegCodec {
  decode: (
    data: Uint8Array,
    opts?: { useTArray?: boolean; maxResolutionInMP?: number },
  ) => { width: number; height: number; data: Uint8Array };
  encode: (
    image: { data: Uint8Array; width: number; height: number },
    quality?: number,
  ) => { data: Uint8Array };
}

const jpeg = jpegJs as unknown as JpegCodec;

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

function thumbnailSize(width: number, height: number): {
  width: number;
  height: number;
} {
  const edge = Math.max(width, height);
  if (edge <= THUMBNAIL_MAX_EDGE) return { width, height };
  const scale = THUMBNAIL_MAX_EDGE / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function compositeOnWhite(pixels: Uint8Array): void {
  for (let i = 0; i < pixels.byteLength; i += 4) {
    const alpha = pixels[i + 3]! / 255;
    if (alpha >= 1) continue;
    pixels[i] = Math.round(pixels[i]! * alpha + 255 * (1 - alpha));
    pixels[i + 1] = Math.round(pixels[i + 1]! * alpha + 255 * (1 - alpha));
    pixels[i + 2] = Math.round(pixels[i + 2]! * alpha + 255 * (1 - alpha));
    pixels[i + 3] = 255;
  }
}

function resizeRgba(
  src: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  destWidth: number,
  destHeight: number,
): Uint8Array {
  if (sourceWidth === destWidth && sourceHeight === destHeight) return src;
  const dest = new Uint8Array(destWidth * destHeight * 4);
  const xRatio = sourceWidth === 1 ? 0 : (sourceWidth - 1) / Math.max(1, destWidth - 1);
  const yRatio =
    sourceHeight === 1 ? 0 : (sourceHeight - 1) / Math.max(1, destHeight - 1);
  for (let y = 0; y < destHeight; y += 1) {
    const sourceY = y * yRatio;
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < destWidth; x += 1) {
      const sourceX = x * xRatio;
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const fx = sourceX - x0;
      const destIndex = (y * destWidth + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const c00 = src[(y0 * sourceWidth + x0) * 4 + channel]!;
        const c10 = src[(y0 * sourceWidth + x1) * 4 + channel]!;
        const c01 = src[(y1 * sourceWidth + x0) * 4 + channel]!;
        const c11 = src[(y1 * sourceWidth + x1) * 4 + channel]!;
        dest[destIndex + channel] = Math.round(
          c00 * (1 - fx) * (1 - fy) +
            c10 * fx * (1 - fy) +
            c01 * (1 - fx) * fy +
            c11 * fx * fy,
        );
      }
    }
  }
  return dest;
}

function decodeRgba(
  bytes: Uint8Array,
  info: ImageInfo,
): { width: number; height: number; data: Uint8Array } {
  if (info.mime === "image/jpeg") {
    const decoded = jpeg.decode(bytes, {
      useTArray: true,
      maxResolutionInMP: MAX_DECODE_PIXELS / 1_000_000,
    });
    return {
      width: decoded.width,
      height: decoded.height,
      data: decoded.data,
    };
  }
  if (info.mime === "image/png") {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { width: png.width, height: png.height, data: png.data };
  }
  if (info.mime === "image/gif") {
    const reader = new GifReader(Buffer.from(bytes));
    const data = new Uint8Array(reader.width * reader.height * 4);
    reader.decodeAndBlitFrameRGBA(0, data);
    return { width: reader.width, height: reader.height, data };
  }
  throw new PublicError("暂不支持生成该格式的缩略图");
}

function encodeJpeg(
  pixels: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const encoded = jpeg.encode(
    { data: pixels, width, height },
    THUMBNAIL_JPEG_QUALITY,
  );
  return encoded.data instanceof Uint8Array
    ? encoded.data
    : new Uint8Array(encoded.data);
}

/** True when both edges already fit the thumbnail bound. */
export function fitsThumbnailBound(width: number, height: number): boolean {
  return Math.max(width, height) <= THUMBNAIL_MAX_EDGE;
}

/**
 * Rebuild a JPEG thumbnail from a decodable original. WebP is not decoded
 * here; callers may copy an already-small original as the cache bytes.
 */
export function renderPostImageThumbnail(bytes: Uint8Array): ThumbnailBytes {
  const info = inspectPostImage(bytes);
  if (!canRenderPostImageThumbnail(info.mime)) {
    throw new PublicError("暂不支持生成该格式的缩略图");
  }
  const target = thumbnailSize(info.width, info.height);
  const decoded = decodeRgba(bytes, info);
  compositeOnWhite(decoded.data);
  const resized = resizeRgba(
    decoded.data,
    decoded.width,
    decoded.height,
    target.width,
    target.height,
  );
  return {
    mime: THUMBNAIL_MIME,
    bytes: encodeJpeg(resized, target.width, target.height),
    width: target.width,
    height: target.height,
  };
}

export function canRenderPostImageThumbnail(mime: PostImageMime): boolean {
  return mime === "image/jpeg" || mime === "image/png" || mime === "image/gif";
}
