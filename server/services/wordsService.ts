import type { Database } from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  countWords,
  findRandomReviewWord,
  findRandomUnlearnedWord,
  findRandomWord,
  findWordByEnglish,
  getUserWordStats,
  insertWord,
  listAllWords,
  listMasteredWords,
  listUnlearnedWords,
  listWrongWordRows,
  listWrongWords,
  upsertWordPractice,
} from "@/server/data/words";
import { getUserConfig, setUserConfig } from "@/server/services/userConfig";
import { ServiceError } from "@/server/services/errors";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import type {
  UserWordProgress,
  Word,
  WordQuizPayload,
  WordStats,
  WordWithLearnedCount,
  WordWithWrongCount,
} from "@/shared/types/api/words";
import { getRuntimeConfig } from "../infra/runtimeConfig";

function pickDistractors(all: Word[], wordId: string, count = 3): Word[] {
  return all
    .filter((w) => w.id !== wordId)
    .sort(() => Math.random() - 0.5)
    .slice(0, count);
}

function pickWeightedWrong(rows: { wrong_count: number }[]): number {
  const totalWeight = rows.reduce((sum, r) => sum + r.wrong_count, 0);
  let random = Math.random() * totalWeight;
  for (let i = 0; i < rows.length; i++) {
    random -= rows[i].wrong_count;
    if (random <= 0) return i;
  }
  return 0;
}

function pickWeightedWrongWords(
  db: Database,
  userId: string,
  limit: number,
): Word[] {
  const rows = listWrongWordRows(db, userId);
  if (rows.length === 0) return [];

  const pool = [...rows];
  const results: Word[] = [];

  for (let i = 0; i < limit && pool.length > 0; i++) {
    const index = pickWeightedWrong(pool);
    const selected = pool.splice(index, 1)[0];
    results.push({
      id: selected.id,
      english: selected.english,
      phonetic: selected.phonetic,
      definition: selected.definition,
      created_at: selected.created_at,
    });
  }

  return results;
}

export function parseWordLine(
  line: string,
): { english: string; definition: string } | null {
  const idx = line.indexOf("#");
  if (idx === -1) return null;

  const english = line.substring(0, idx).trim();
  const definition = line.substring(idx + 1).trim();
  if (!english || !definition) return null;
  return { english, definition };
}

export class WordsService {
  constructor(private readonly db: Database) {}

  ensureSampleWords(): void {
    if (countWords(this.db) > 0) return;

    const possiblePaths = [
      path.join(path.join(getRuntimeConfig().appDir, "public/words.txt")),
    ];

    for (const wordsFilePath of possiblePaths) {
      if (!fs.existsSync(wordsFilePath)) continue;
      try {
        const wordsData = fs.readFileSync(wordsFilePath, "utf-8");
        const trimmed = wordsData.trim();
        if (trimmed && trimmed !== "PLACEHOLDER_FOR_WORDS_DATA") {
          const imported = this.importFromText(wordsData);
          console.log(`Imported ${imported} words from ${wordsFilePath}`);
          return;
        }
      } catch (e) {
        console.error("Failed to read words.txt:", e);
      }
    }
  }

  importFromText(text: string): number {
    const words = text
      .split("￥")
      .map((w) => w.trim())
      .filter(Boolean);
    let imported = 0;

    this.db.transaction(() => {
      for (const wordStr of words) {
        const parsed = parseWordLine(wordStr);
        if (!parsed) continue;
        if (findWordByEnglish(this.db, parsed.english)) continue;

        insertWord(
          this.db,
          crypto.randomUUID(),
          parsed.english,
          "",
          parsed.definition,
        );
        imported++;
      }
    })();

    return imported;
  }

  stats(userId: string, timezoneOffset?: number): WordStats {
    return getUserWordStats(this.db, userId, timezoneOffset);
  }

  nextWord(userId: string): WordQuizPayload {
    const unlearned = listUnlearnedWords(this.db, userId, 100);
    const wrong = pickWeightedWrongWords(this.db, userId, 50);
    const all = listAllWords(this.db);

    const useWrong = Math.random() < 0.3 && wrong.length > 0;
    let word: Word | undefined;

    if (useWrong) {
      word = wrong[Math.floor(Math.random() * wrong.length)];
    } else if (unlearned.length > 0) {
      word = unlearned[Math.floor(Math.random() * unlearned.length)];
    } else if (wrong.length > 0) {
      word = wrong[Math.floor(Math.random() * wrong.length)];
    } else if (all.length > 0) {
      word = all[Math.floor(Math.random() * all.length)];
    }

    if (!word) return { word: null, distractors: [] };
    return { word, distractors: pickDistractors(all, word.id) };
  }

  nextWrongWord(userId: string): WordQuizPayload {
    const wrong = pickWeightedWrongWords(this.db, userId, 50);
    const all = listAllWords(this.db);

    if (wrong.length === 0) return { word: null, distractors: [] };

    const word = wrong[Math.floor(Math.random() * wrong.length)];
    return { word, distractors: pickDistractors(all, word.id) };
  }

  selfDisciplineWord(userId: string): WordQuizPayload {
    const wrongRows = listWrongWordRows(this.db, userId);

    let word: Word | null = null;

    if (wrongRows.length > 0) {
      const rand = Math.random();

      if (rand < 0.5) {
        const index = pickWeightedWrong(wrongRows);
        const row = wrongRows[index];
        word = {
          id: row.id,
          english: row.english,
          phonetic: row.phonetic,
          definition: row.definition,
          created_at: row.created_at,
        };
      } else if (rand < 0.9) {
        word = findRandomUnlearnedWord(this.db, userId);
      } else {
        word = findRandomReviewWord(this.db, userId);
      }
    }

    if (!word) {
      word = findRandomWord(this.db);
    }

    if (!word) {
      throw new ServiceError("暂无单词", 404);
    }

    const all = listAllWords(this.db);
    return { word, distractors: pickDistractors(all, word.id) };
  }

  recordPractice(
    userId: string,
    wordId: string,
    correct: boolean,
    mastered = false,
  ): UserWordProgress {
    return upsertWordPractice(this.db, userId, wordId, correct, mastered);
  }

  wrongWords(
    userId: string,
    offset: number,
    limit: number,
  ): { words: WordWithWrongCount[]; total: number } {
    return listWrongWords(this.db, userId, offset, limit);
  }

  masteredWords(
    userId: string,
    offset: number,
    limit: number,
  ): { words: WordWithLearnedCount[]; total: number } {
    return listMasteredWords(this.db, userId, offset, limit);
  }

  getSelfDisciplineMode(userId: string): boolean {
    return (
      getUserConfig(this.db, userId, USER_CONFIG.SELF_DISCIPLINE_MODE) ===
      "true"
    );
  }

  setSelfDisciplineMode(userId: string, enabled: boolean): boolean {
    setUserConfig(
      this.db,
      userId,
      USER_CONFIG.SELF_DISCIPLINE_MODE,
      String(enabled),
    );
    return enabled;
  }
}

export function createWordsService(db: Database): WordsService {
  return new WordsService(db);
}
