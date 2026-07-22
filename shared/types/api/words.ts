import { z } from "zod";

export const wordSchema = z
  .object({
    id: z.string(),
    english: z.string(),
    phonetic: z.string(),
    definition: z.string(),
    created_at: z.string(),
  })
  .strict();
export type Word = z.infer<typeof wordSchema>;

export const userWordProgressSchema = z
  .object({
    user_id: z.string(),
    word_id: z.string(),
    learned_count: z.number().int(),
    wrong_count: z.number().int(),
    status: z.enum(["unlearned", "learning", "mastered"]),
    last_practiced_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type UserWordProgress = z.infer<typeof userWordProgressSchema>;

export const wordStatsSchema = z
  .object({
    total: z.number().int(),
    learned: z.number().int(),
    wrong: z.number().int(),
    today_learned: z.number().int(),
  })
  .strict();
export type WordStats = z.infer<typeof wordStatsSchema>;

export const wordWithWrongCountSchema = wordSchema
  .extend({
    wrong_count: z.number().int(),
  })
  .strict();
export type WordWithWrongCount = z.infer<typeof wordWithWrongCountSchema>;

export const wordWithLearnedCountSchema = wordSchema
  .extend({
    learned_count: z.number().int(),
  })
  .strict();
export type WordWithLearnedCount = z.infer<typeof wordWithLearnedCountSchema>;

export const wordQuizPayloadSchema = z
  .object({
    word: wordSchema.nullable(),
    distractors: z.array(wordSchema),
  })
  .strict();
export type WordQuizPayload = z.infer<typeof wordQuizPayloadSchema>;
