export const BLOB_READER_ZOOM_MIN = 0.6;
export const BLOB_READER_ZOOM_MAX = 2.5;
export const BLOB_READER_ZOOM_DEFAULT = 1;

export const blobReaderConfigSchema = z
  .object({
    grayscale: z.boolean(),
    zoom: z
      .number()
      .finite()
      .min(BLOB_READER_ZOOM_MIN)
      .max(BLOB_READER_ZOOM_MAX),
  })
  .strict();

export type BlobReaderConfig = z.infer<typeof blobReaderConfigSchema>;

export function parseBlobReaderGrayscale(value: string | null): boolean {
  return value !== "false";
}

export function clampBlobReaderZoom(value: number): number {
  return Math.min(BLOB_READER_ZOOM_MAX, Math.max(BLOB_READER_ZOOM_MIN, value));
}

export function parseBlobReaderZoom(value: string | null): number {
  if (!value) return BLOB_READER_ZOOM_DEFAULT;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return BLOB_READER_ZOOM_DEFAULT;
  return clampBlobReaderZoom(parsed);
}
import { z } from "zod";
