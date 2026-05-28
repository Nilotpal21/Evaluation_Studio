import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureConnected, Project, PublicApiKey } from '@agent-platform/database/models';
import { createPublicApiKey, findPublicApiKeys } from '@/repos/sdk-repo';

const MONGOMS_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const TEST_PROJECT_ID = 'proj-sdk-keys';
const TEST_TENANT_ID = 'tenant-sdk-keys';

let mongoServer: MongoMemoryServer;
const envSnapshot = {
  MONGODB_MANAGED: process.env.MONGODB_MANAGED,
  MONGODB_URL: process.env.MONGODB_URL,
  MONGODB_URI: process.env.MONGODB_URI,
  ENCRYPTION_ENABLED: process.env.ENCRYPTION_ENABLED,
  ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY,
};

const TEST_ENCRYPTION_MASTER_KEY = 'a'.repeat(64);

describe('sdk key serialization', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({
      binary: { version: MONGOMS_VERSION },
    });

    delete process.env.MONGODB_MANAGED;
    process.env.MONGODB_URL = mongoServer.getUri('studio_sdk_keys_serialization');
    delete process.env.MONGODB_URI;
    delete process.env.ENCRYPTION_ENABLED;
    process.env.ENCRYPTION_MASTER_KEY = TEST_ENCRYPTION_MASTER_KEY;

    await ensureConnected(process.env.MONGODB_URL);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();

    process.env.MONGODB_MANAGED = envSnapshot.MONGODB_MANAGED;
    process.env.MONGODB_URL = envSnapshot.MONGODB_URL;
    process.env.MONGODB_URI = envSnapshot.MONGODB_URI;
    process.env.ENCRYPTION_ENABLED = envSnapshot.ENCRYPTION_ENABLED;
    process.env.ENCRYPTION_MASTER_KEY = envSnapshot.ENCRYPTION_MASTER_KEY;
  });

  beforeEach(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }

    await Project.create({
      _id: TEST_PROJECT_ID,
      name: 'SDK Keys Project',
      slug: 'sdk-keys-project',
      ownerId: 'user-sdk-keys',
      tenantId: TEST_TENANT_ID,
      kind: 'application',
    });
  });

  it('round-trips allowedOrigins and permissions without JSON stringification', async () => {
    const created = await createPublicApiKey(TEST_PROJECT_ID, TEST_TENANT_ID, {
      keyPrefix: 'pk_live_123',
      keyHash: 'hash-live-123',
      name: 'Live SDK Key',
      allowedOrigins: ['https://widget.example.com'],
      permissions: { chat: true, voice: false },
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    expect(created.allowedOrigins).toEqual(['https://widget.example.com']);
    expect(created.permissions).toEqual({ chat: true, voice: false });

    const [listed] = await findPublicApiKeys({
      projectId: TEST_PROJECT_ID,
      tenantId: TEST_TENANT_ID,
    });

    expect(listed).toMatchObject({
      id: created.id,
      keyPrefix: 'pk_live_123',
      name: 'Live SDK Key',
      allowedOrigins: ['https://widget.example.com'],
      permissions: { chat: true, voice: false },
      tenantId: TEST_TENANT_ID,
      projectId: TEST_PROJECT_ID,
      isActive: true,
    });
  });

  it('normalizes legacy double-serialized allowedOrigins and permissions on read', async () => {
    const now = new Date('2026-04-06T00:00:00.000Z');

    await PublicApiKey.collection.insertOne({
      _id: 'legacy-sdk-key',
      projectId: TEST_PROJECT_ID,
      tenantId: TEST_TENANT_ID,
      keyPrefix: 'pk_legacy',
      keyHash: 'hash-legacy-123',
      name: 'Legacy SDK Key',
      allowedOrigins: ['["https://legacy.example.com"]'],
      permissions: '{"chat":true,"voice":false}',
      lastUsedAt: null,
      expiresAt: null,
      isActive: true,
      _v: 1,
      createdAt: now,
      updatedAt: now,
    });

    const [listed] = await findPublicApiKeys({
      projectId: TEST_PROJECT_ID,
      tenantId: TEST_TENANT_ID,
    });

    expect(listed?.allowedOrigins).toEqual(['https://legacy.example.com']);
    expect(listed?.permissions).toEqual({ chat: true, voice: false });
  });
});
