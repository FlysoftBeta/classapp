import { observeActionResult } from "./runtime";
import { client } from "@/client/interact/remote/client";

const {
  adminFetchSelfDisciplineModeAction,
  adminUpdateSelfDisciplineModeAction,
  fetchMasteredWordsAction,
  fetchNextWordAction,
  fetchNextWrongWordAction,
  fetchSelfDisciplineModeAction,
  fetchSelfDisciplineWordAction,
  fetchWordStatsAction,
  fetchWrongWordsAction,
  recordWordPracticeAction,
  updateSelfDisciplineModeAction,
} = client.actions;
import type {
  UserWordProgress,
  Word,
  WordQuizPayload,
  WordStats,
  WordWithLearnedCount,
  WordWithWrongCount,
} from "@/shared/types/api/words";

export type {
  Word,
  WordStats,
  WordQuizPayload,
  WordWithWrongCount,
  WordWithLearnedCount,
  UserWordProgress,
};

export async function fetchWordStats(timezoneOffset?: number) {
  const result = await fetchWordStatsAction({ timezoneOffset });
  observeActionResult(result);
  return result.ok ? result.data : { stats: null, error: result.error.message };
}

export async function fetchNextWord(): Promise<WordQuizPayload> {
  const result = await fetchNextWordAction();
  observeActionResult(result);
  return result.ok ? result.data : { word: null, distractors: [] };
}

export async function fetchNextWrongWord(): Promise<WordQuizPayload> {
  const result = await fetchNextWrongWordAction();
  observeActionResult(result);
  return result.ok ? result.data : { word: null, distractors: [] };
}

export async function fetchSelfDisciplineWord(): Promise<
  WordQuizPayload & { error?: string }
> {
  const result = await fetchSelfDisciplineWordAction();
  observeActionResult(result);
  if (result.ok) return result.data;
  return { word: null, distractors: [], error: result.error.message };
}

export async function recordWordPractice(body: {
  wordId: string;
  correct: boolean;
  mastered?: boolean;
}) {
  const result = await recordWordPracticeAction(body);
  observeActionResult(result);
  return result.ok ? result.data : { error: result.error.message };
}

export async function fetchWrongWords(offset: number, limit: number) {
  const result = await fetchWrongWordsAction({ offset, limit });
  observeActionResult(result);
  return result.ok ? result.data : { words: [], total: 0 };
}

export async function fetchMasteredWords(offset: number, limit: number) {
  const result = await fetchMasteredWordsAction({ offset, limit });
  observeActionResult(result);
  return result.ok ? result.data : { words: [], total: 0 };
}

export async function fetchSelfDisciplineMode() {
  const result = await fetchSelfDisciplineModeAction();
  observeActionResult(result);
  return result.ok ? result.data : { enabled: false };
}

export async function updateSelfDisciplineMode(enabled: boolean) {
  const result = await updateSelfDisciplineModeAction({ enabled });
  observeActionResult(result);
  return result.ok ? result.data : { enabled: false };
}

export async function adminFetchSelfDisciplineMode(userId: string) {
  const result = await adminFetchSelfDisciplineModeAction({ userId });
  observeActionResult(result);
  return result.ok ? result.data : { enabled: false };
}

export async function adminUpdateSelfDisciplineMode(
  userId: string,
  enabled: boolean,
) {
  const result = await adminUpdateSelfDisciplineModeAction({ userId, enabled });
  observeActionResult(result);
  return result.ok ? result.data : { enabled: false };
}
