import type { Database } from "better-sqlite3";
import { toDbTimestamp } from "@/shared/time";
import type {
  UserWordProgress,
  Word,
  WordStats,
  WordWithLearnedCount,
  WordWithWrongCount,
} from "@/shared/types/api/words";

export function initWordSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS words (
      id           TEXT PRIMARY KEY,
      english      TEXT NOT NULL,
      phonetic     TEXT NOT NULL DEFAULT '',
      definition   TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_words_english ON words(english);

    CREATE TABLE IF NOT EXISTS user_word_progress (
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      word_id           TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      learned_count     INTEGER NOT NULL DEFAULT 0,
      wrong_count       INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'unlearned' CHECK (status IN ('unlearned', 'learning', 'mastered')),
      last_practiced_at TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, word_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_word_progress_user ON user_word_progress(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_word_progress_status ON user_word_progress(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_user_word_progress_wrong ON user_word_progress(user_id, wrong_count DESC);
  `);
}

export function purgeUserWordProgress(db: Database, userId: string): void {
  db.prepare("DELETE FROM user_word_progress WHERE user_id = ?").run(userId);
}

function rowToWord(row: Record<string, unknown>): Word {
  return {
    id: row.id as string,
    english: row.english as string,
    phonetic: row.phonetic as string,
    definition: row.definition as string,
    created_at: row.created_at as string,
  };
}

export function findWordById(db: Database, id: string): Word | null {
  const row = db
    .prepare(
      `SELECT id, english, phonetic, definition, created_at FROM words WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToWord(row) : null;
}

export function findWordByEnglish(db: Database, english: string): Word | null {
  const row = db
    .prepare(
      `SELECT id, english, phonetic, definition, created_at FROM words WHERE english = ?`,
    )
    .get(english) as Record<string, unknown> | undefined;
  return row ? rowToWord(row) : null;
}

export function listAllWords(db: Database): Word[] {
  const rows = db
    .prepare(
      `SELECT id, english, phonetic, definition, created_at FROM words ORDER BY english`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToWord);
}

export function countWords(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM words").get() as {
    cnt: number;
  };
  return row.cnt;
}

export function insertWord(
  db: Database,
  id: string,
  english: string,
  phonetic: string,
  definition: string,
): void {
  db.prepare(
    `INSERT INTO words (id, english, phonetic, definition) VALUES (?, ?, ?, ?)`,
  ).run(id, english, phonetic, definition);
}

export function findUserWordProgress(
  db: Database,
  userId: string,
  wordId: string,
): UserWordProgress | null {
  const row = db
    .prepare(
      `SELECT user_id, word_id, learned_count, wrong_count, status, last_practiced_at, created_at, updated_at
       FROM user_word_progress WHERE user_id = ? AND word_id = ?`,
    )
    .get(userId, wordId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    user_id: row.user_id as string,
    word_id: row.word_id as string,
    learned_count: row.learned_count as number,
    wrong_count: row.wrong_count as number,
    status: row.status as UserWordProgress["status"],
    last_practiced_at: (row.last_practiced_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function getUserWordStats(
  db: Database,
  userId: string,
  timezoneOffset?: number,
): WordStats {
  const total = countWords(db);

  const learned = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM user_word_progress
       WHERE user_id = ? AND status = 'mastered'`,
    )
    .get(userId) as { cnt: number };

  const wrong = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM user_word_progress
       WHERE user_id = ? AND wrong_count > 0`,
    )
    .get(userId) as { cnt: number };

  const offset = timezoneOffset ?? -new Date().getTimezoneOffset();
  const now = new Date();
  now.setMinutes(now.getMinutes() + offset);
  const todayStr = now.toISOString().split("T")[0];
  const today = db
    .prepare(
      `SELECT COUNT(DISTINCT word_id) as cnt FROM user_word_progress
       WHERE user_id = ? AND DATE(last_practiced_at, ?) = ?`,
    )
    .get(userId, `${offset >= 0 ? "+" : ""}${offset} minutes`, todayStr) as {
    cnt: number;
  };

  return {
    total,
    learned: learned.cnt,
    wrong: wrong.cnt,
    today_learned: today?.cnt || 0,
  };
}

export function upsertWordPractice(
  db: Database,
  userId: string,
  wordId: string,
  correct: boolean,
  mastered: boolean,
): UserWordProgress {
  const now = toDbTimestamp(new Date());
  const progress = findUserWordProgress(db, userId, wordId);

  if (progress) {
    let newLearned = progress.learned_count;
    let newWrong = progress.wrong_count;
    let newStatus = progress.status;

    if (correct) {
      newLearned += mastered ? 2 : 1;
      if (newLearned >= 2) {
        newStatus = "mastered";
      } else if (newStatus === "unlearned") {
        newStatus = "learning";
      }
      if (progress.wrong_count > 0) {
        newWrong = Math.max(0, progress.wrong_count - 1);
      }
    } else {
      newWrong += 1;
      if (newStatus === "mastered") {
        newStatus = "learning";
      }
    }

    db.prepare(
      `UPDATE user_word_progress
       SET learned_count = ?, wrong_count = ?, status = ?, last_practiced_at = ?, updated_at = ?
       WHERE user_id = ? AND word_id = ?`,
    ).run(newLearned, newWrong, newStatus, now, now, userId, wordId);

    return {
      ...progress,
      learned_count: newLearned,
      wrong_count: newWrong,
      status: newStatus,
      last_practiced_at: now,
      updated_at: now,
    };
  }

  const learnedCount = correct ? (mastered ? 2 : 1) : 0;
  const wrongCount = correct ? 0 : 1;
  const status: UserWordProgress["status"] =
    learnedCount >= 2 ? "mastered" : "learning";

  db.prepare(
    `INSERT INTO user_word_progress (user_id, word_id, learned_count, wrong_count, status, last_practiced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, wordId, learnedCount, wrongCount, status, now, now, now);

  return {
    user_id: userId,
    word_id: wordId,
    learned_count: learnedCount,
    wrong_count: wrongCount,
    status,
    last_practiced_at: now,
    created_at: now,
    updated_at: now,
  };
}

export function listWrongWords(
  db: Database,
  userId: string,
  offset: number,
  limit: number,
): { words: WordWithWrongCount[]; total: number } {
  const total = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM user_word_progress
       WHERE user_id = ? AND wrong_count > 0`,
    )
    .get(userId) as { cnt: number };

  const rows = db
    .prepare(
      `SELECT w.id, w.english, w.phonetic, w.definition, w.created_at, p.wrong_count
       FROM words w
       JOIN user_word_progress p ON w.id = p.word_id
       WHERE p.user_id = ? AND p.wrong_count > 0
       ORDER BY p.wrong_count DESC, p.updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(userId, limit, offset) as Record<string, unknown>[];

  return {
    words: rows.map((row) => ({
      ...rowToWord(row),
      wrong_count: row.wrong_count as number,
    })),
    total: total.cnt,
  };
}

export function listMasteredWords(
  db: Database,
  userId: string,
  offset: number,
  limit: number,
): { words: WordWithLearnedCount[]; total: number } {
  const total = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM user_word_progress
       WHERE user_id = ? AND status = 'mastered'`,
    )
    .get(userId) as { cnt: number };

  const rows = db
    .prepare(
      `SELECT w.id, w.english, w.phonetic, w.definition, w.created_at, p.learned_count
       FROM words w
       JOIN user_word_progress p ON w.id = p.word_id
       WHERE p.user_id = ? AND p.status = 'mastered'
       ORDER BY p.updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(userId, limit, offset) as Record<string, unknown>[];

  return {
    words: rows.map((row) => ({
      ...rowToWord(row),
      learned_count: row.learned_count as number,
    })),
    total: total.cnt,
  };
}

export function listUnlearnedWords(
  db: Database,
  userId: string,
  limit: number,
): Word[] {
  const rows = db
    .prepare(
      `SELECT w.id, w.english, w.phonetic, w.definition, w.created_at
       FROM words w
       LEFT JOIN user_word_progress p ON w.id = p.word_id AND p.user_id = ?
       WHERE p.user_id IS NULL OR p.status = 'unlearned'
       ORDER BY w.english
       LIMIT ?`,
    )
    .all(userId, limit) as Record<string, unknown>[];
  return rows.map(rowToWord);
}

export interface WrongWordRow extends Word {
  wrong_count: number;
}

export function listWrongWordRows(
  db: Database,
  userId: string,
): WrongWordRow[] {
  const rows = db
    .prepare(
      `SELECT w.id, w.english, w.phonetic, w.definition, w.created_at, p.wrong_count
       FROM words w
       JOIN user_word_progress p ON w.id = p.word_id
       WHERE p.user_id = ? AND p.wrong_count > 0`,
    )
    .all(userId) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...rowToWord(row),
    wrong_count: row.wrong_count as number,
  }));
}

export function findRandomUnlearnedWord(
  db: Database,
  userId: string,
): Word | null {
  const row = db
    .prepare(
      `SELECT w.id, w.english, w.phonetic, w.definition, w.created_at
       FROM words w
       LEFT JOIN user_word_progress p ON w.id = p.word_id AND p.user_id = ?
       WHERE p.user_id IS NULL OR p.status = 'unlearned'
       ORDER BY RANDOM()
       LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;
  return row ? rowToWord(row) : null;
}

export function findRandomReviewWord(
  db: Database,
  userId: string,
): Word | null {
  const row = db
    .prepare(
      `SELECT w.id, w.english, w.phonetic, w.definition, w.created_at
       FROM words w
       JOIN user_word_progress p ON w.id = p.word_id
       WHERE p.user_id = ? AND p.status = 'mastered' AND p.learned_count < 5
       ORDER BY RANDOM()
       LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;
  return row ? rowToWord(row) : null;
}

export function findRandomWord(db: Database): Word | null {
  const row = db
    .prepare(
      `SELECT id, english, phonetic, definition, created_at
       FROM words ORDER BY RANDOM() LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  return row ? rowToWord(row) : null;
}
