export const USER_CONFIG = {
  THEME_MODE: "theme_mode",
  ACTIVE_ARTICLE_ID: "active_article_id",
  RECENT_STICKERS: "recent_stickers",
  SELF_DISCIPLINE_MODE: "self_discipline_mode",
  DO_NOT_DISTURB: "do_not_disturb",
} as const;

export const OFFLINE_WRITABLE_USER_CONFIG = [
  USER_CONFIG.THEME_MODE,
  USER_CONFIG.DO_NOT_DISTURB,
] as const;

export type UserConfigKey = (typeof USER_CONFIG)[keyof typeof USER_CONFIG];
