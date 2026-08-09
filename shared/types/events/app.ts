import { z } from "zod";
import { articleWithMetaSchema } from "../api/article";
import { appDisableStateSchema } from "../api/app";
import { userSchema } from "../api/user";

export const articleSidebarUpdatedPayloadSchema = z
  .object({
    entry: articleWithMetaSchema.optional(),
    removed: z.object({ article_id: z.string() }).strict().optional(),
    current_article_id: z.string().nullable().optional(),
    /** Fallback when the delta cannot be computed. */
    refresh: z.literal(true).optional(),
  })
  .strict();
export type ArticleSidebarUpdatedPayload = z.infer<
  typeof articleSidebarUpdatedPayloadSchema
>;

export const articleListUpdatedPayloadSchema = z
  .object({
    entry: articleWithMetaSchema.optional(),
    removed: z.object({ article_id: z.string() }).strict().optional(),
    /** New row — increment total even when not on page 0. */
    created: z.literal(true).optional(),
    /** Fallback when the delta cannot be computed. */
    refresh: z.literal(true).optional(),
  })
  .strict();
export type ArticleListUpdatedPayload = z.infer<
  typeof articleListUpdatedPayloadSchema
>;

export const appStatePayloadSchema = z
  .object({
    v: z.literal(1),
    konami_locked: z.boolean(),
    session_valid: z.boolean(),
    /** Present on anonymous /api/app/state responses. */
    reason: z.enum(["anonymous", "session_expired"]).optional(),
    user: userSchema.nullable(),
    app: appDisableStateSchema,
    flags: z
      .object({
        idle_lock_enabled: z.boolean(),
        system_locked: z.boolean(),
      })
      .strict(),
    client_invalid: z.boolean().optional(),
  })
  .strict();
export type AppStatePayload = z.infer<typeof appStatePayloadSchema>;
