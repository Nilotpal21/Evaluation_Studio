/**
 * Integration test: Progress Service
 *
 * Tests progress lifecycle with real MongoDB via mongodb-memory-server.
 * This is a PACKAGE-level integration test (not E2E) — the academy package
 * has no HTTP layer. Direct storage access is the correct integration boundary.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongooseAcademyStorage } from '../../storage/mongoose-storage.js';
import { createContentService } from '../../services/content-service.js';
import { createGamificationService } from '../../services/gamification-service.js';
import { createProgressService, clearRateLimits } from '../../services/progress-service.js';
import { clearContentCaches } from '../../content/content-loader.js';
import { join } from 'node:path';
import type { ProgressService, GamificationService } from '../../types.js';

const CONTENT_ROOT = join(import.meta.dirname, '..', '..', '..', 'content');
const MONGO_BOOT_TIMEOUT_MS = 120_000;

let mongod: MongoMemoryServer | undefined;
let connection: mongoose.Connection | undefined;
let storage: MongooseAcademyStorage;
let progressService: ProgressService;
let gamificationService: GamificationService;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongod.getUri()).asPromise();
  storage = new MongooseAcademyStorage(connection);
  const content = createContentService(CONTENT_ROOT);
  gamificationService = createGamificationService(storage, content);
  progressService = createProgressService(storage, content, gamificationService);
}, MONGO_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await connection?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  const collections = Object.values(connection?.collections ?? {});
  for (const collection of collections) {
    await collection.deleteMany({});
  }
  clearRateLimits();
  clearContentCaches();
});

describe('getProgress — upsert-on-read', () => {
  it('creates a new progress doc for unknown user', async () => {
    const progress = await progressService.getProgress('user-new');
    expect(progress.userId).toBe('user-new');
    expect(progress.points).toBe(0);
    expect(progress.badges).toEqual([]);
    expect(progress.modules.size).toBe(0);
  });

  it('returns existing progress for known user', async () => {
    await progressService.getProgress('user-existing');
    const second = await progressService.getProgress('user-existing');
    expect(second.userId).toBe('user-existing');
    expect(second.points).toBe(0);
  });
});

describe('markContentRead', () => {
  it('marks content as read and awards lesson points', async () => {
    const progress = await progressService.markContentRead('user-read', 'getting-started');
    expect(progress.points).toBe(10);
    expect(progress.modules.get('getting-started')?.contentRead).toBe(true);
  });

  it('awards points cumulatively for multiple modules', async () => {
    await progressService.markContentRead('user-multi', 'getting-started');
    const progress = await progressService.markContentRead('user-multi', 'abl-basics');
    expect(progress.points).toBe(20);
  });
});

describe('submitQuiz — diminishing points', () => {
  it('awards 100 points on first passing attempt', async () => {
    await progressService.getProgress('user-quiz1');
    const content = createContentService(CONTENT_ROOT);
    const quiz = await content.getQuizInternal('getting-started');

    const answers = quiz.questions.map((q) => {
      if (q.type === 'mcq') {
        const correct = q.options?.find((o) => o.correct);
        return { questionId: q.id, answer: correct?.id ?? '' };
      }
      return { questionId: q.id, answer: q.answer ?? '' };
    });

    const result = await progressService.submitQuiz('user-quiz1', 'getting-started', answers);
    expect(result.passed).toBe(true);
    expect(result.pointsAwarded).toBe(100);
  });

  it('awards 50 points on second passing attempt', async () => {
    await progressService.getProgress('user-quiz2');
    const content = createContentService(CONTENT_ROOT);
    const quiz = await content.getQuizInternal('getting-started');

    const wrongAnswers = quiz.questions.map((q) => ({
      questionId: q.id,
      answer: 'definitely-wrong',
    }));
    const failResult = await progressService.submitQuiz(
      'user-quiz2',
      'getting-started',
      wrongAnswers,
    );
    expect(failResult.passed).toBe(false);

    const correctAnswers = quiz.questions.map((q) => {
      if (q.type === 'mcq') {
        const correct = q.options?.find((o) => o.correct);
        return { questionId: q.id, answer: correct?.id ?? '' };
      }
      return { questionId: q.id, answer: q.answer ?? '' };
    });
    const passResult = await progressService.submitQuiz(
      'user-quiz2',
      'getting-started',
      correctAnswers,
    );
    expect(passResult.passed).toBe(true);
    expect(passResult.pointsAwarded).toBe(50);
  });

  it('does not re-award points if quiz already passed', async () => {
    await progressService.getProgress('user-quiz3');
    const content = createContentService(CONTENT_ROOT);
    const quiz = await content.getQuizInternal('getting-started');

    const correctAnswers = quiz.questions.map((q) => {
      if (q.type === 'mcq') {
        const correct = q.options?.find((o) => o.correct);
        return { questionId: q.id, answer: correct?.id ?? '' };
      }
      return { questionId: q.id, answer: q.answer ?? '' };
    });

    const first = await progressService.submitQuiz('user-quiz3', 'getting-started', correctAnswers);
    expect(first.pointsAwarded).toBe(100);

    const second = await progressService.submitQuiz(
      'user-quiz3',
      'getting-started',
      correctAnswers,
    );
    expect(second.pointsAwarded).toBe(0);
  });
});

describe('submitQuiz — rate limiting', () => {
  it('blocks 4th attempt within rate window', async () => {
    await progressService.getProgress('user-rate');
    const wrongAnswers = [{ questionId: 'gs-q1', answer: 'wrong' }];

    await progressService.submitQuiz('user-rate', 'getting-started', wrongAnswers);
    await progressService.submitQuiz('user-rate', 'getting-started', wrongAnswers);
    await progressService.submitQuiz('user-rate', 'getting-started', wrongAnswers);

    await expect(
      progressService.submitQuiz('user-rate', 'getting-started', wrongAnswers),
    ).rejects.toThrow(/rate limit/i);
  });
});

describe('setPersona', () => {
  it('updates selected persona', async () => {
    const progress = await progressService.setPersona('user-persona', 'agent-builder');
    expect(progress.selectedPersona).toBe('agent-builder');
  });
});

describe('resetProgress', () => {
  it('resets all progress fields', async () => {
    await progressService.markContentRead('user-reset', 'getting-started');
    await progressService.setPersona('user-reset', 'agent-builder');
    await progressService.resetProgress('user-reset');

    const progress = await progressService.getProgress('user-reset');
    expect(progress.points).toBe(0);
    expect(progress.badges).toEqual([]);
    expect(progress.selectedPersona).toBeNull();
  });
});
