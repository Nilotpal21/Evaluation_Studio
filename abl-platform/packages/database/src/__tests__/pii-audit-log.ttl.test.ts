import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PIIAuditLog } from '../models/pii-audit-log.model.js';

const TEST_MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const TEST_MONGO_LAUNCH_TIMEOUT_MS = 60_000;

describe('PIIAuditLog TTL integration', () => {
  let mongod: MongoMemoryServer | undefined;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      binary: { version: TEST_MONGO_VERSION },
      instance: {
        launchTimeout: TEST_MONGO_LAUNCH_TIMEOUT_MS,
        args: ['--setParameter', 'ttlMonitorSleepSecs=1'],
      },
    });

    await mongoose.connect(mongod.getUri(), {
      directConnection: true,
      connectTimeoutMS: 120_000,
      socketTimeoutMS: 120_000,
      serverSelectionTimeoutMS: 120_000,
      heartbeatFrequencyMS: 60_000,
    });
    await mongoose.connection.asPromise();
    await PIIAuditLog.syncIndexes();
  });

  beforeEach(async () => {
    await PIIAuditLog.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod?.stop();
  });

  test('auto-deletes expired records via the Mongo TTL monitor', async () => {
    const entry = await PIIAuditLog.create({
      tenantId: 'tenant-ttl',
      projectId: 'project-ttl',
      sessionId: 'session-ttl',
      tokenId: 'token-ttl',
      piiType: 'email',
      consumer: 'llm',
      action: 'tokenize',
      expireAt: new Date(Date.now() - 5_000),
    });

    expect(await PIIAuditLog.countDocuments({ _id: entry._id })).toBe(1);

    await expect
      .poll(() => PIIAuditLog.countDocuments({ _id: entry._id }), {
        timeout: 20_000,
        interval: 1_000,
      })
      .toBe(0);
  });
});
