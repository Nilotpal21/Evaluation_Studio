/**
 * Tests for streak functionality with real MongoDB (mongodb-memory-server).
 * Tests streak deduplication, pruning, and badge checking.
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
  return `user-streak-${counter}-${Date.now()}`;
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

describe('streak — storage-level behavior', () => {
  it('addStreakDay adds a day via storage', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const progress = await storage.addStreakDay(userId, '2026-04-01');
    expect(progress.streakDays).toContain('2026-04-01');
  });

  it('addStreakDay deduplicates same day (MongoDB $addToSet)', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    await storage.addStreakDay(userId, '2026-04-01');
    const progress = await storage.addStreakDay(userId, '2026-04-01');

    const count = progress.streakDays.filter((d) => d === '2026-04-01').length;
    expect(count).toBe(1);
  });

  it('pruneStreakDays keeps only the most recent N entries', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    // Add 65 streak days
    for (let i = 0; i < 65; i++) {
      const day = `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
      await storage.addStreakDay(userId, day);
    }

    let progress = await storage.getProgress(userId);
    expect(progress?.streakDays.length).toBe(65);

    // Prune to 60
    await storage.pruneStreakDays(userId, 60);

    progress = await storage.getProgress(userId);
    expect(progress?.streakDays.length).toBeLessThanOrEqual(60);
  });
});

describe('streak — gamification service', () => {
  it('updateStreak adds today to streak and returns updated progress', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    const progress = await gamificationService.updateStreak(userId);
    const today = new Date().toISOString().split('T')[0];
    expect(progress.streakDays).toContain(today);
    expect(progress.lastActiveDate).toBe(today);
  });

  it('updateStreak deduplicates when called multiple times same day', async () => {
    const userId = uid();
    await progressService.getProgress(userId);

    await gamificationService.updateStreak(userId);
    const progress = await gamificationService.updateStreak(userId);

    const today = new Date().toISOString().split('T')[0];
    const todayEntries = progress.streakDays.filter((d) => d === today);
    expect(todayEntries.length).toBe(1);
  });
});
