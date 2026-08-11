import { expectBoolean, expectString, withActionSession } from "./_base";
import { ContractViolationError } from "@/server/services/incidentService";
import type { ActionInput } from "@/shared/protocol/actions";

export async function fetchWordStatsAction(
  input?: ActionInput<"fetchWordStatsAction">,
) {
  return withActionSession(async (session) => {
    const words = await (await session.asActor()).words();
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
  return withActionSession(async (session) => {
    return (await (await session.asActor()).words()).nextWord();
  });
}

export async function fetchNextWrongWordAction() {
  return withActionSession(async (session) => {
    return (await (await session.asActor()).words()).nextWrongWord();
  });
}

export async function fetchSelfDisciplineWordAction() {
  return withActionSession(async (session) => {
    return (await (await session.asActor()).words()).selfDisciplineWord();
  });
}

export async function recordWordPracticeAction(
  input: ActionInput<"recordWordPracticeAction">,
) {
  return withActionSession(async (session) => {
    const wordId = expectString(input.wordId, "wordId 无效");
    if (typeof input.correct !== "boolean") {
      throw new ContractViolationError("correct 参数无效");
    }
    const mastered =
      input.mastered === undefined
        ? false
        : expectBoolean(input.mastered, "mastered 参数无效");
    const progress = await (
      await (await session.asActor()).words()
    ).recordPractice(wordId, input.correct, mastered);
    return { progress };
  });
}

export async function fetchWrongWordsAction(
  input?: ActionInput<"fetchWrongWordsAction">,
) {
  return withActionSession(async (session) => {
    const offset =
      typeof input?.offset === "number" && Number.isFinite(input.offset)
        ? Math.max(0, Math.floor(input.offset))
        : 0;
    const limit =
      typeof input?.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.floor(input.limit))
        : 10;
    return (await (await session.asActor()).words()).wrongWords(offset, limit);
  });
}

export async function fetchMasteredWordsAction(
  input?: ActionInput<"fetchMasteredWordsAction">,
) {
  return withActionSession(async (session) => {
    const offset =
      typeof input?.offset === "number" && Number.isFinite(input.offset)
        ? Math.max(0, Math.floor(input.offset))
        : 0;
    const limit =
      typeof input?.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.floor(input.limit))
        : 10;
    return (await (await session.asActor()).words()).masteredWords(
      offset,
      limit,
    );
  });
}

export async function importWordsAction(
  input: ActionInput<"importWordsAction">,
) {
  return withActionSession(async (session) => {
    const text = expectString(input.text, "导入内容不能为空", { trim: false });
    return (await (await session.asActor()).words()).importWords(text);
  });
}

export async function fetchSelfDisciplineModeAction() {
  return withActionSession(async (session) => {
    return (await (await session.asActor()).words()).getSelfDisciplineMode();
  });
}

export async function updateSelfDisciplineModeAction(
  input: ActionInput<"updateSelfDisciplineModeAction">,
) {
  return withActionSession(async (session) => {
    const enabled = expectBoolean(input.enabled, "enabled 参数无效");
    return (await (await session.asActor()).words()).setSelfDisciplineMode(
      enabled,
    );
  });
}

export async function adminFetchSelfDisciplineModeAction(
  input: ActionInput<"adminFetchSelfDisciplineModeAction">,
) {
  return withActionSession(async (session) => {
    const userId = expectString(input.userId, "用户不存在");
    return (await (await session.asActor()).words()).adminGetSelfDisciplineMode(
      userId,
    );
  });
}

export async function adminUpdateSelfDisciplineModeAction(
  input: ActionInput<"adminUpdateSelfDisciplineModeAction">,
) {
  return withActionSession(async (session) => {
    const userId = expectString(input.userId, "用户不存在");
    const enabled = expectBoolean(input.enabled, "enabled 参数无效");
    return (await (await session.asActor()).words()).adminSetSelfDisciplineMode(
      userId,
      enabled,
    );
  });
}
