/**
 * Integration test: Gamification Service
 *
 * Tests badge checking and streak management with real MongoDB.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongooseAcademyStorage } from '../../storage/mongoose-storage.js';
import { createContentService } from '../../services/content-service.js';
import { createGamificationService } from '../../services/gamification-service.js';
import { clearContentCaches } from '../../content/content-loader.js';
import { join } from 'node:path';
import type { GamificationService, AcademyProgress } from '../../types.js';

const CONTENT_ROOT = join(import.meta.dirname, '..', '..', '..', 'content');
const MONGO_BOOT_TIMEOUT_MS = 120_000;

let mongod: MongoMemoryServer | undefined;
let connection: mongoose.Connection | undefined;
let storage: MongooseAcademyStorage;
let gamification: GamificationService;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongod.getUri()).asPromise();
  storage = new MongooseAcademyStorage(connection);
  const content = createContentService(CONTENT_ROOT);
  gamification = createGamificationService(storage, content);
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
  clearContentCaches();
});

describe('updateStreak', () => {
  it('adds today as a streak day', async () => {
    await storage.upsertProgress('user-streak', { email: 'test@test.com', points: 0 });
    const progress = await gamification.updateStreak('user-streak');
    const today = new Date().toISOString().split('T')[0];
    expect(progress.streakDays).toContain(today);
  });

  it('deduplicates same-day calls', async () => {
    await storage.upsertProgress('user-dedup', { email: 'test@test.com', points: 0 });
    await gamification.updateStreak('user-dedup');
    const progress = await gamification.updateStreak('user-dedup');
    const today = new Date().toISOString().split('T')[0];
    const todayCounts = progress.streakDays.filter((d) => d === today);
    expect(todayCounts).toHaveLength(1);
  });
});

describe('checkBadges — first quiz pass', () => {
  it('awards first-quiz badge when a quiz is passed', async () => {
    await storage.upsertProgress('user-badge', { email: 'test@test.com', points: 100 });
    await storage.updateModuleProgress('user-badge', 'getting-started', {
      quizPassed: true,
      bestScore: 0.8,
      quizAttempts: 1,
    });

    const progress = await storage.getProgress('user-badge');
    const newBadges = await gamification.checkBadges(progress!);
    expect(newBadges).toContain('first-quiz');
  });

  it('awards perfect-score badge when score is 1.0', async () => {
    await storage.upsertProgress('user-perfect', { email: 'test@test.com', points: 100 });
    await storage.updateModuleProgress('user-perfect', 'getting-started', {
      quizPassed: true,
      bestScore: 1.0,
      quizAttempts: 1,
    });

    const progress = await storage.getProgress('user-perfect');
    const newBadges = await gamification.checkBadges(progress!);
    expect(newBadges).toContain('perfect-score');
  });

  it('does not re-award existing badges', async () => {
    await storage.upsertProgress('user-nodup', {
      email: 'test@test.com',
      points: 100,
      badges: ['first-quiz'],
    });
    await storage.updateModuleProgress('user-nodup', 'getting-started', {
      quizPassed: true,
      bestScore: 0.8,
      quizAttempts: 1,
    });

    const progress = await storage.getProgress('user-nodup');
    const newBadges = await gamification.checkBadges(progress!);
    expect(newBadges).not.toContain('first-quiz');
  });
});

describe('deriveRank', () => {
  it('returns Newcomer for 0 points', () => {
    expect(gamification.deriveRank({ points: 0 } as AcademyProgress)).toBe('Newcomer');
  });

  it('returns Expert for 5000+ points', () => {
    expect(gamification.deriveRank({ points: 5000 } as AcademyProgress)).toBe('Expert');
  });

  it('returns Master for 8000+ points', () => {
    expect(gamification.deriveRank({ points: 8000 } as AcademyProgress)).toBe('Master');
  });
});
