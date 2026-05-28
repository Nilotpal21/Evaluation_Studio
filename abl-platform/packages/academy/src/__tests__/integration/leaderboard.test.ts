/**
 * Integration test: Leaderboard Service
 *
 * Tests leaderboard queries with real MongoDB via mongodb-memory-server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongooseAcademyStorage } from '../../storage/mongoose-storage.js';
import { createLeaderboardService } from '../../services/leaderboard-service.js';
import type { LeaderboardService } from '../../types.js';

const MONGO_BOOT_TIMEOUT_MS = 120_000;

let mongod: MongoMemoryServer | undefined;
let connection: mongoose.Connection | undefined;
let storage: MongooseAcademyStorage;
let leaderboard: LeaderboardService;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongod.getUri()).asPromise();
  storage = new MongooseAcademyStorage(connection);
  leaderboard = createLeaderboardService(storage);
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
});

async function seedUser(userId: string, points: number, displayName: string | null = null) {
  await storage.upsertProgress(userId, {
    email: userId + '@test.com',
    displayName,
    points,
  });
}

describe('getLeaderboard', () => {
  it('returns empty array when no users', async () => {
    const result = await leaderboard.getLeaderboard(10, 0);
    expect(result).toEqual([]);
  });

  it('returns users sorted by points descending', async () => {
    await seedUser('user-a', 100, 'Alice');
    await seedUser('user-b', 300, 'Bob');
    await seedUser('user-c', 200, 'Charlie');

    const result = await leaderboard.getLeaderboard(10, 0);
    expect(result).toHaveLength(3);
    expect(result[0].userId).toBe('user-b');
    expect(result[0].points).toBe(300);
    expect(result[1].userId).toBe('user-c');
    expect(result[2].userId).toBe('user-a');
  });

  it('respects limit parameter', async () => {
    await seedUser('user-1', 300);
    await seedUser('user-2', 200);
    await seedUser('user-3', 100);

    const result = await leaderboard.getLeaderboard(2, 0);
    expect(result).toHaveLength(2);
  });

  it('respects offset parameter', async () => {
    await seedUser('user-1', 300);
    await seedUser('user-2', 200);
    await seedUser('user-3', 100);

    const result = await leaderboard.getLeaderboard(10, 1);
    expect(result).toHaveLength(2);
    expect(result[0].userId).toBe('user-2');
  });

  it('does NOT expose email in results', async () => {
    await seedUser('user-priv', 500, 'Private');
    const result = await leaderboard.getLeaderboard(10, 0);
    expect(result[0]).not.toHaveProperty('email');
    expect(result[0]).toHaveProperty('userId');
    expect(result[0]).toHaveProperty('points');
  });
});

describe('getUserPosition', () => {
  it('returns 0 for unknown user', async () => {
    expect(await leaderboard.getUserPosition('nonexistent')).toBe(0);
  });

  it('returns correct 1-indexed position', async () => {
    await seedUser('user-a', 100);
    await seedUser('user-b', 300);
    await seedUser('user-c', 200);

    expect(await leaderboard.getUserPosition('user-b')).toBe(1);
    expect(await leaderboard.getUserPosition('user-c')).toBe(2);
    expect(await leaderboard.getUserPosition('user-a')).toBe(3);
  });

  it('updates position after point changes', async () => {
    await seedUser('user-a', 100);
    await seedUser('user-b', 200);

    expect(await leaderboard.getUserPosition('user-a')).toBe(2);
    await storage.upsertProgress('user-a', { points: 500 });
    expect(await leaderboard.getUserPosition('user-a')).toBe(1);
  });
});
