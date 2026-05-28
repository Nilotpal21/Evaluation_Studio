/**
 * Tests for ProgressService with real MongoDB (mongodb-memory-server).
 * Each test uses unique user IDs to avoid cross-test contamination.
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
  return `user-progress-${counter}-${Date.now()}`;
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

describe('getProgress — upsert-on-read', () => {
  it('creates a new progress document for unknown user', async () => {
    const userId = uid();
    const progress = await progressService.getProgress(userId);

    expect(progress.userId).toBe(userId);
    expect(progress.points).toBe(0);
    expect(progress.badges).toEqual([]);
    expect(progress.streakDays).toEqual([]);
    expect(progress.selectedPersona).toBeNull();
  });

  it('returns existing progress for known user', async () => {
    const userId = uid();
    await progressService.getProgress(userId);
    const progress = await progressService.getProgress(userId);

    expect(progress.userId).toBe(userId);
    expect(progress.points).toBe(0);
  });
});

describe('markContentRead', () => {
  it('marks content as read and awards points', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const progress = await progressService.markContentRead(userId, 'getting-started');

    expect(progress.points).toBe(10);
    const mod = progress.modules.get('getting-started');
    expect(mod).toBeDefined();
    expect(mod?.contentRead).toBe(true);
  });

  it('accumulates points for multiple modules', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    await progressService.markContentRead(userId, 'getting-started');
    const progress = await progressService.markContentRead(userId, 'core-concepts');

    expect(progress.points).toBe(20);
  });
});

describe('submitQuiz — diminishing points', () => {
  it('awards 100 points on first attempt pass', async () => {
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

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.pointsAwarded).toBe(100);
  });

  it('awards 50 points on second attempt pass', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const quiz = await contentService.getQuizInternal('getting-started');

    const wrongAnswers = quiz.questions.map((q) => ({
      questionId: q.id,
      answer: 'wrong',
    }));
    await progressService.submitQuiz(userId, 'getting-started', wrongAnswers);

    const correctAnswers = quiz.questions.map((q) => {
      if (q.type === 'mcq') {
        const correct = q.options?.find((o) => o.correct);
        return { questionId: q.id, answer: correct?.id ?? '' };
      }
      return { questionId: q.id, answer: q.answer ?? '' };
    });

    const result = await progressService.submitQuiz(userId, 'getting-started', correctAnswers);

    expect(result.passed).toBe(true);
    expect(result.pointsAwarded).toBe(50);
  });

  it('awards 25 points on third+ attempt pass', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const quiz = await contentService.getQuizInternal('getting-started');

    const wrongAnswers = quiz.questions.map((q) => ({
      questionId: q.id,
      answer: 'wrong',
    }));

    await progressService.submitQuiz(userId, 'getting-started', wrongAnswers);
    await progressService.submitQuiz(userId, 'getting-started', wrongAnswers);

    const correctAnswers = quiz.questions.map((q) => {
      if (q.type === 'mcq') {
        const correct = q.options?.find((o) => o.correct);
        return { questionId: q.id, answer: correct?.id ?? '' };
      }
      return { questionId: q.id, answer: q.answer ?? '' };
    });

    const result = await progressService.submitQuiz(userId, 'getting-started', correctAnswers);

    expect(result.passed).toBe(true);
    expect(result.pointsAwarded).toBe(25);
  });

  it('awards 0 points when retaking an already-passed quiz', async () => {
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

    const result1 = await progressService.submitQuiz(userId, 'getting-started', correctAnswers);
    expect(result1.pointsAwarded).toBe(100);

    const result2 = await progressService.submitQuiz(userId, 'getting-started', correctAnswers);
    expect(result2.pointsAwarded).toBe(0);
  });
});

describe('setPersona', () => {
  it('sets the selected persona', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const progress = await progressService.setPersona(userId, 'agent-builder');
    expect(progress.selectedPersona).toBe('agent-builder');
  });

  it('overwrites existing persona', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    await progressService.setPersona(userId, 'agent-builder');
    const progress = await progressService.setPersona(userId, 'agent-architect');
    expect(progress.selectedPersona).toBe('agent-architect');
  });
});

describe('resetProgress', () => {
  it('resets all progress data', async () => {
    const userId = uid();
    await progressService.getProgress(userId);
    await progressService.markContentRead(userId, 'getting-started');
    await progressService.setPersona(userId, 'agent-builder');

    await progressService.resetProgress(userId);

    const progress = await progressService.getProgress(userId);
    expect(progress.points).toBe(0);
    expect(progress.badges).toEqual([]);
    expect(progress.selectedPersona).toBeNull();
  });
});
