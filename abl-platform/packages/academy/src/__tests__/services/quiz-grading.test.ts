/**
 * Tests for quiz grading with real MongoDB (mongodb-memory-server).
 * Tests the full quiz submission flow through progress service.
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
  return `user-quiz-${counter}-${Date.now()}`;
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

describe('submitQuiz — full grading flow', () => {
  it('returns per-question results with explanations', async () => {
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

    expect(result.results.length).toBe(quiz.questions.length);
    for (const r of result.results) {
      expect(r.correct).toBe(true);
      expect(r.explanation).toBeTruthy();
    }
  });

  it('handles fill-blank questions in real quizzes', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    // The getting-started quiz has a fill-blank question (gs-q2)
    const quiz = await contentService.getQuizInternal('getting-started');
    const fillBlank = quiz.questions.find((q) => q.type === 'fill-blank');
    expect(fillBlank).toBeDefined();

    const answers = quiz.questions.map((q) => {
      if (q.type === 'fill-blank') {
        return { questionId: q.id, answer: q.answer ?? '' };
      }
      const correct = q.options?.find((o) => o.correct);
      return { questionId: q.id, answer: correct?.id ?? '' };
    });

    const result = await progressService.submitQuiz(userId, 'getting-started', answers);

    expect(result.passed).toBe(true);
  });

  it('records best score correctly across attempts', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const quiz = await contentService.getQuizInternal('getting-started');

    // First attempt: all wrong
    const wrongAnswers = quiz.questions.map((q) => ({
      questionId: q.id,
      answer: 'wrong',
    }));
    await progressService.submitQuiz(userId, 'getting-started', wrongAnswers);

    // Second attempt: all correct
    const correctAnswers = quiz.questions.map((q) => {
      if (q.type === 'mcq') {
        const correct = q.options?.find((o) => o.correct);
        return { questionId: q.id, answer: correct?.id ?? '' };
      }
      return { questionId: q.id, answer: q.answer ?? '' };
    });
    await progressService.submitQuiz(userId, 'getting-started', correctAnswers);

    // Check that best score is 1.0
    const progress = await progressService.getProgress(userId);
    const mod = progress.modules.get('getting-started');
    expect(mod?.bestScore).toBe(1);
    expect(mod?.quizPassed).toBe(true);
    expect(mod?.quizAttempts).toBe(2);
  });

  it('increments attempt count even on failures', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const quiz = await contentService.getQuizInternal('getting-started');
    const wrongAnswers = quiz.questions.map((q) => ({
      questionId: q.id,
      answer: 'wrong',
    }));

    await progressService.submitQuiz(userId, 'getting-started', wrongAnswers);
    await progressService.submitQuiz(userId, 'getting-started', wrongAnswers);

    const progress = await progressService.getProgress(userId);
    const mod = progress.modules.get('getting-started');
    expect(mod?.quizAttempts).toBe(2);
    expect(mod?.quizPassed).toBe(false);
    expect(mod?.bestScore).toBe(0);
  });

  it('returns rank in quiz result', async () => {
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

    expect(result.rank).toBeDefined();
    expect(typeof result.rank).toBe('string');
  });
});

describe('submitQuiz — rate limiting', () => {
  it('allows up to 3 attempts within the rate window', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const quiz = await contentService.getQuizInternal('getting-started');
    const wrongAnswers = quiz.questions.map((q) => ({
      questionId: q.id,
      answer: 'wrong',
    }));

    // Attempts 1-3 should succeed
    await progressService.submitQuiz(userId, 'getting-started', wrongAnswers);
    await progressService.submitQuiz(userId, 'getting-started', wrongAnswers);
    await progressService.submitQuiz(userId, 'getting-started', wrongAnswers);

    // 4th attempt should be rate-limited
    await expect(
      progressService.submitQuiz(userId, 'getting-started', wrongAnswers),
    ).rejects.toThrow(/Rate limit exceeded/);
  });

  it('rate limit is per-module (different modules not affected)', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const quiz1 = await contentService.getQuizInternal('getting-started');
    const wrongAnswers1 = quiz1.questions.map((q) => ({
      questionId: q.id,
      answer: 'wrong',
    }));

    // Exhaust rate limit for getting-started
    await progressService.submitQuiz(userId, 'getting-started', wrongAnswers1);
    await progressService.submitQuiz(userId, 'getting-started', wrongAnswers1);
    await progressService.submitQuiz(userId, 'getting-started', wrongAnswers1);

    // Different module should still work
    const quiz2 = await contentService.getQuizInternal('core-concepts');
    const wrongAnswers2 = quiz2.questions.map((q) => ({
      questionId: q.id,
      answer: 'wrong',
    }));

    // Should not throw
    await progressService.submitQuiz(userId, 'core-concepts', wrongAnswers2);
  });
});
