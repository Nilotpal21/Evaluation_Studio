/**
 * Tests for GamificationService with real MongoDB (mongodb-memory-server).
 * Tests badge triggers, streak management, and rank derivation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { join } from 'node:path';
import { createMongooseAcademyStorage } from '../../storage/mongoose-storage.js';
import { createContentService } from '../../services/content-service.js';
import { createGamificationService } from '../../services/gamification-service.js';
import { createProgressService, clearRateLimits } from '../../services/progress-service.js';
import { clearContentCaches } from '../../content/content-loader.js';
import type { AcademyStoragePort } from '../../storage/storage-port.js';
import type { ContentService, GamificationService, ProgressService } from '../../types.js';

const CONTENT_ROOT = join(import.meta.dirname, '..', '..', '..', 'content');
const MONGO_BOOT_TIMEOUT_MS = 120_000;

let mongod: MongoMemoryServer | undefined;
let conn: mongoose.Connection | undefined;
let storage: AcademyStoragePort;
let contentService: ContentService;
let gamificationService: GamificationService;
let progressService: ProgressService;
let counter = 0;

function uid(): string {
  counter++;
  return `user-gamification-${counter}-${Date.now()}`;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  conn = mongoose.createConnection(mongod.getUri());
  await conn.asPromise();
  storage = createMongooseAcademyStorage(conn);
  contentService = createContentService(CONTENT_ROOT);
  gamificationService = createGamificationService(storage, contentService);
  progressService = createProgressService(storage, contentService, gamificationService);
}, MONGO_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(() => {
  clearRateLimits();
  clearContentCaches();
});

async function passQuiz(userId: string, moduleId: string): Promise<void> {
  const quiz = await contentService.getQuizInternal(moduleId);
  const correctAnswers = quiz.questions.map((q) => {
    if (q.type === 'mcq') {
      const correct = q.options?.find((o) => o.correct);
      return { questionId: q.id, answer: correct?.id ?? '' };
    }
    return { questionId: q.id, answer: q.answer ?? '' };
  });
  await progressService.submitQuiz(userId, moduleId, correctAnswers);
}

describe('badge triggers — first-quiz-pass', () => {
  it('awards first-quiz badge on first quiz pass', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const quiz = await contentService.getQuizInternal('getting-started');
    const correctAnswers = quiz.questions.map((q) => {
      if (q.type === 'mcq') {
        const correct = q.options?.find((o) => o.correct);
        return { questionId: q.id, answer: correct?.id ?? '' };
      }
      return { questionId: q.id, answer: q.answer ?? '' };
    });

    const result = await progressService.submitQuiz(userId, 'getting-started', correctAnswers);

    expect(result.newBadges).toContain('first-quiz');
  });

  it('does not re-award first-quiz badge on subsequent passes', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    // Pass first quiz
    await passQuiz(userId, 'getting-started');

    // Pass second quiz — first-quiz badge should not appear again
    clearRateLimits(); // reset rate limits for new module
    const quiz = await contentService.getQuizInternal('core-concepts');
    const correctAnswers = quiz.questions.map((q) => {
      if (q.type === 'mcq') {
        const correct = q.options?.find((o) => o.correct);
        return { questionId: q.id, answer: correct?.id ?? '' };
      }
      return { questionId: q.id, answer: q.answer ?? '' };
    });

    const result = await progressService.submitQuiz(userId, 'core-concepts', correctAnswers);

    expect(result.newBadges).not.toContain('first-quiz');
  });
});

describe('badge triggers — perfect-quiz', () => {
  it('awards perfect-score badge on 100% quiz', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const quiz = await contentService.getQuizInternal('getting-started');
    const correctAnswers = quiz.questions.map((q) => {
      if (q.type === 'mcq') {
        const correct = q.options?.find((o) => o.correct);
        return { questionId: q.id, answer: correct?.id ?? '' };
      }
      return { questionId: q.id, answer: q.answer ?? '' };
    });

    const result = await progressService.submitQuiz(userId, 'getting-started', correctAnswers);

    expect(result.score).toBe(1);
    expect(result.newBadges).toContain('perfect-score');
  });
});

describe('badge triggers — course completion', () => {
  it('awards course badge when all modules in a course are passed', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    // Platform foundations has 3 modules: getting-started, core-concepts, reference-community
    await passQuiz(userId, 'getting-started');

    clearRateLimits();
    await passQuiz(userId, 'core-concepts');

    clearRateLimits();
    const result3Quiz = await contentService.getQuizInternal('reference-community');
    const answers3 = result3Quiz.questions.map((q) => {
      if (q.type === 'mcq') {
        const correct = q.options?.find((o) => o.correct);
        return { questionId: q.id, answer: correct?.id ?? '' };
      }
      return { questionId: q.id, answer: q.answer ?? '' };
    });
    const result3 = await progressService.submitQuiz(userId, 'reference-community', answers3);

    // The quick-start badge has trigger "course:platform-foundations"
    const allBadges = (await progressService.getProgress(userId)).badges;
    expect(allBadges).toContain('quick-start');
  });
});

describe('updateStreak', () => {
  it('adds today to streak days', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const progress = await gamificationService.updateStreak(userId);
    const today = new Date().toISOString().split('T')[0];
    expect(progress.streakDays).toContain(today);
  });

  it('deduplicates same-day calls', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    await gamificationService.updateStreak(userId);
    const progress = await gamificationService.updateStreak(userId);

    // Should only have today once (MongoDB $addToSet handles this)
    const today = new Date().toISOString().split('T')[0];
    const todayCount = progress.streakDays.filter((d) => d === today).length;
    expect(todayCount).toBe(1);
  });
});

describe('deriveRank', () => {
  it('returns Newcomer for fresh user', async () => {
    const userId = uid();
    const progress = await progressService.getProgress(userId);

    const rank = gamificationService.deriveRank(progress);
    expect(rank).toBe('Newcomer');
  });

  it('returns correct rank after earning points', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    // Pass several quizzes to accumulate points
    // Each first pass = 100 points, markContentRead = 10 each
    // After 5 quizzes passed: 500 points => Explorer
    await passQuiz(userId, 'getting-started');
    clearRateLimits();
    await passQuiz(userId, 'core-concepts');
    clearRateLimits();
    await passQuiz(userId, 'reference-community');
    clearRateLimits();
    await passQuiz(userId, 'abl-basics');
    clearRateLimits();
    await passQuiz(userId, 'agent-configuration');

    const progress = await progressService.getProgress(userId);
    // 5 x 100 = 500 points
    expect(progress.points).toBe(500);

    const rank = gamificationService.deriveRank(progress);
    expect(rank).toBe('Explorer');
  });
});
