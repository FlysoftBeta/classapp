import { z } from "zod";
import { PublicError } from "@/server/services/incidentService";

const manifestUrlSchema = z.union([z.literal(""), z.string().max(2048).url()]);

export function normalizeManifestUrl(value: string): string {
  const parsed = manifestUrlSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new PublicError("Manifest 链接无效");
  }
  return parsed.data;
}
