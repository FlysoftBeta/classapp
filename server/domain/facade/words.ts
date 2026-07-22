import type { Actor } from "@/server/session/session";
import type { WordsService } from "@/server/services/wordsService";
import type {
  UserWordProgress,
  WordQuizPayload,
  WordStats,
  WordWithLearnedCount,
  WordWithWrongCount,
} from "@/shared/types/api/words";

export class WordsActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly words: WordsService,
  ) {}

  async stats(timezoneOffset?: number): Promise<WordStats> {
    const user = await this.actor.requireFeature("learning");
    return this.words.stats(user.id, timezoneOffset);
  }

  async nextWord(): Promise<WordQuizPayload> {
    const user = await this.actor.requireFeature("learning");
    return this.words.nextWord(user.id);
  }

  async nextWrongWord(): Promise<WordQuizPayload> {
    const user = await this.actor.requireFeature("learning");
    return this.words.nextWrongWord(user.id);
  }

  async selfDisciplineWord(): Promise<WordQuizPayload> {
    const user = await this.actor.requireFeature("learning");
    return this.words.selfDisciplineWord(user.id);
  }

  async recordPractice(
    wordId: string,
    correct: boolean,
    mastered = false,
  ): Promise<UserWordProgress> {
    const user = await this.actor.requireFeature("learning");
    return this.words.recordPractice(user.id, wordId, correct, mastered);
  }

  async wrongWords(
    offset: number,
    limit: number,
  ): Promise<{ words: WordWithWrongCount[]; total: number }> {
    const user = await this.actor.requireFeature("learning");
    return this.words.wrongWords(user.id, offset, limit);
  }

  async masteredWords(
    offset: number,
    limit: number,
  ): Promise<{ words: WordWithLearnedCount[]; total: number }> {
    const user = await this.actor.requireFeature("learning");
    return this.words.masteredWords(user.id, offset, limit);
  }

  async importWords(text: string): Promise<{ imported: number }> {
    await this.actor.requireAdmin();
    return { imported: this.words.importFromText(text) };
  }

  async getSelfDisciplineMode(): Promise<{ enabled: boolean }> {
    const user = await this.actor.requireFeature("learning");
    return { enabled: this.words.getSelfDisciplineMode(user.id) };
  }

  async setSelfDisciplineMode(enabled: boolean): Promise<{ enabled: boolean }> {
    const user = await this.actor.requireFeature("learning");
    return { enabled: this.words.setSelfDisciplineMode(user.id, enabled) };
  }

  async adminGetSelfDisciplineMode(
    userId: string,
  ): Promise<{ enabled: boolean }> {
    await this.actor.requireAdmin();
    return { enabled: this.words.getSelfDisciplineMode(userId) };
  }

  async adminSetSelfDisciplineMode(
    userId: string,
    enabled: boolean,
  ): Promise<{ enabled: boolean }> {
    await this.actor.requireAdmin();
    return { enabled: this.words.setSelfDisciplineMode(userId, enabled) };
  }
}
