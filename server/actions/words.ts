import { expectBoolean, expectString, withActionScope } from "./_base";
import { ContractViolationError } from "@/server/services/incidentService";
import type { ActionInput } from "@/shared/protocol/actions";

export async function fetchWordStatsAction(
  input?: ActionInput<"fetchWordStatsAction">,
) {
  return withActionScope(async (scope) => {
    const words = scope.facades().words();
    const timezoneOffset =
      input?.timezoneOffset === undefined
        ? undefined
        : typeof input.timezoneOffset === "number" &&
            Number.isFinite(input.timezoneOffset)
          ? input.timezoneOffset
          : undefined;
    return { stats: await words.stats(timezoneOffset) };
  });
}

export async function fetchNextWordAction() {
  return withActionScope(async (scope) => {
    return scope.facades().words().nextWord();
  });
}

export async function fetchNextWrongWordAction() {
  return withActionScope(async (scope) => {
    return scope.facades().words().nextWrongWord();
  });
}

export async function fetchSelfDisciplineWordAction() {
  return withActionScope(async (scope) => {
    return scope.facades().words().selfDisciplineWord();
  });
}

export async function recordWordPracticeAction(
  input: ActionInput<"recordWordPracticeAction">,
) {
  return withActionScope(async (scope) => {
    const wordId = expectString(input.wordId, "wordId 无效");
    if (typeof input.correct !== "boolean") {
      throw new ContractViolationError("correct 参数无效");
    }
    const mastered =
      input.mastered === undefined
        ? false
        : expectBoolean(input.mastered, "mastered 参数无效");
    const progress = await scope
      .facades()
      .words()
      .recordPractice(wordId, input.correct, mastered);
    return { progress };
  });
}

export async function fetchWrongWordsAction(
  input?: ActionInput<"fetchWrongWordsAction">,
) {
  return withActionScope(async (scope) => {
    const offset =
      typeof input?.offset === "number" && Number.isFinite(input.offset)
        ? Math.max(0, Math.floor(input.offset))
        : 0;
    const limit =
      typeof input?.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.floor(input.limit))
        : 10;
    return scope.facades().words().wrongWords(offset, limit);
  });
}

export async function fetchMasteredWordsAction(
  input?: ActionInput<"fetchMasteredWordsAction">,
) {
  return withActionScope(async (scope) => {
    const offset =
      typeof input?.offset === "number" && Number.isFinite(input.offset)
        ? Math.max(0, Math.floor(input.offset))
        : 0;
    const limit =
      typeof input?.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.floor(input.limit))
        : 10;
    return scope.facades().words().masteredWords(offset, limit);
  });
}

export async function importWordsAction(
  input: ActionInput<"importWordsAction">,
) {
  return withActionScope(async (scope) => {
    const text = expectString(input.text, "导入内容不能为空", { trim: false });
    return scope.facades().words().importWords(text);
  });
}

export async function fetchSelfDisciplineModeAction() {
  return withActionScope(async (scope) => {
    return scope.facades().words().getSelfDisciplineMode();
  });
}

export async function updateSelfDisciplineModeAction(
  input: ActionInput<"updateSelfDisciplineModeAction">,
) {
  return withActionScope(async (scope) => {
    const enabled = expectBoolean(input.enabled, "enabled 参数无效");
    return scope.facades().words().setSelfDisciplineMode(enabled);
  });
}

export async function adminFetchSelfDisciplineModeAction(
  input: ActionInput<"adminFetchSelfDisciplineModeAction">,
) {
  return withActionScope(async (scope) => {
    const userId = expectString(input.userId, "用户不存在");
    return scope.facades().words().adminGetSelfDisciplineMode(userId);
  });
}

export async function adminUpdateSelfDisciplineModeAction(
  input: ActionInput<"adminUpdateSelfDisciplineModeAction">,
) {
  return withActionScope(async (scope) => {
    const userId = expectString(input.userId, "用户不存在");
    const enabled = expectBoolean(input.enabled, "enabled 参数无效");
    return scope.facades().words().adminSetSelfDisciplineMode(userId, enabled);
  });
}
