import { z } from "zod";
import { userSchema } from "@/shared/types/api";
import {
  articleListUpdatedPayloadSchema,
  articleSidebarUpdatedPayloadSchema,
  convUpdatedPayloadSchema,
  postChangedPayloadSchema,
  postDeletedPayloadSchema,
  userConfigChangedEventSchema,
} from "@/shared/types/events";

const emptyPayloadSchema = z.object({}).strict();

export const eventContracts = {
  "post.created": postChangedPayloadSchema,
  "post.updated": postChangedPayloadSchema,
  "post.deleted": postDeletedPayloadSchema,
  "conv.updated": convUpdatedPayloadSchema,
  "client.lock_changed": z.object({ konami_locked: z.boolean() }).strict(),
  "client.deleted": emptyPayloadSchema,
  "client.idle_locked": emptyPayloadSchema,
  "user.banned": z.object({ banned_until: z.string() }).strict(),
  "user.unbanned": emptyPayloadSchema,
  "user.muted_changed": z
    .object({
      is_muted: z.number().int(),
      muted_until: z.string().nullable(),
    })
    .strict(),
  "user.profile_changed": z.object({ user: userSchema }).strict(),
  "system.lock_changed": z
    .object({
      idle_lock_enabled: z.boolean().optional(),
      system_locked: z.boolean().optional(),
    })
    .strict(),
  "system.announcement_changed": z
    .object({ revision: z.number().int().nonnegative() })
    .strict(),
  "article.created": z
    .object({
      article_id: z.string(),
      group_id: z.string(),
    })
    .strict(),
  "article.deleted": z
    .object({
      article_id: z.string(),
      group_id: z.string(),
    })
    .strict(),
  "article.bookmark_changed": z
    .object({
      article_id: z.string(),
      user_id: z.string(),
      bookmarked: z.boolean(),
    })
    .strict(),
  "article.reading_changed": z
    .object({
      article_id: z.string(),
      user_id: z.string(),
    })
    .strict(),
  "article.sidebar_updated": articleSidebarUpdatedPayloadSchema,
  "article.list_updated": articleListUpdatedPayloadSchema,
  "user.config_changed": userConfigChangedEventSchema,
  "remote.resubscribe": z.object({ reason: z.string() }).strict(),
  "remote.hello": z.object({ buildId: z.string() }).strict(),
} as const satisfies Record<string, z.ZodType>;

export type EventName = keyof typeof eventContracts;
export type ServerEventName = Exclude<EventName, "remote.hello">;
export type EventData<K extends EventName> = z.output<
  (typeof eventContracts)[K]
>;
