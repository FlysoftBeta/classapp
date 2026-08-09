import type {
  AppDisableReason,
  AppDisableState,
  Conversation,
} from "@/shared/types/api";
import type {
  AppStatePayload,
  PostStreamEvent,
  UserConfigChangedEvent,
} from "@/shared/types/events";

export type AppState =
  | "loading"
  | "konami"
  | "login"
  | "oobe"
  | "app_locked"
  | "app";

export interface OobeState {
  oobe_token: string;
  pin1: string;
  pin2: string;
  step: "pin1" | "pin2_prompt" | "pin2" | "handle" | "username";
  error: string;
  submitting: boolean;
}

export type ConvEntry = Conversation;

export interface SelectedKey {
  type: "group" | "dm";
  id: string;
}

export type AppRoute =
  | { view: "chat"; conversation: SelectedKey | null }
  | { view: "settings" }
  | { view: "admin" }
  | { view: "articles"; conversation?: SelectedKey }
  | {
      view: "reader";
      articleId: string;
      from: "chat" | "articles";
      conversation?: SelectedKey;
    }
  | { view: "learning" }
  | { view: "word-learning" }
  | { view: "wrong-words" }
  | { view: "clear-wrong" }
  | { view: "mastered-words" };

export type ViewType = AppRoute["view"];

export function appStateFromPayload(payload: AppStatePayload): AppState {
  if (payload.konami_locked) return "konami";
  if (!payload.session_valid || !payload.user) return "login";
  if (payload.app.disabled) return "app_locked";
  return "app";
}

export function selectedConversation(
  conversations: ConvEntry[],
  route: AppRoute,
): ConvEntry | null {
  if (route.view !== "chat" || !route.conversation) return null;
  return (
    conversations.find(
      (entry) =>
        entry.type === route.conversation!.type &&
        entry.id === route.conversation!.id,
    ) ?? null
  );
}

export type {
  AppDisableReason,
  AppDisableState,
  AppStatePayload,
  PostStreamEvent,
  UserConfigChangedEvent,
};

