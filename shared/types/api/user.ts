import { z } from "zod";
import { adminAccessSchema } from "@/shared/authority";
import { userFeaturesSchema } from "@/shared/features";

export const userSchema = z
  .object({
    id: z.string(),
    handle: z.string(),
    username: z.string(),
    features: userFeaturesSchema,
    administration: adminAccessSchema,
    is_muted: z.number().int(),
    muted_until: z.string().nullable(),
    banned_until: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();

export type User = z.infer<typeof userSchema>;

/** Reusable identity projection carried beside domain entities on the wire. */
export const userMetadataSchema = z
  .object({
    id: z.string(),
    handle: z.string().nullable(),
    username: z.string(),
  })
  .strict();

export type UserMetadata = z.infer<typeof userMetadataSchema>;
