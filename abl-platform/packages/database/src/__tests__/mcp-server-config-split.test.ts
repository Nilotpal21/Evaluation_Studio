import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { MCPServerConfig } from '../models/mcp-server-config.model.js';
import { runMcpAuthProfileSplitMigration } from '../migrations/mcp-auth-profile-split.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

function baseServerDoc(id: string): Record<string, unknown> {
  return {
    _id: id,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    name: `mcp-${id}`,
    transport: 'http',
    authType: 'none',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('MCPServerConfig schema split', () => {
  test('defines envProfileId with null default', () => {
    const doc = new MCPServerConfig({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'server-1',
      transport: 'http',
      authType: 'none',
    });
    expect(doc.envProfileId).toBeNull();
  });
});

describe('mcp-auth-profile-split migration', () => {
  test('forward migration is idempotent and restore reverts moved rows', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Expected mongoose connection db');
    }

    await db.collection('mcp_server_configs').insertMany([
      {
        ...baseServerDoc('srv-forward-1'),
        authProfileId: 'auth-prof-1',
        envProfileId: null,
      },
      {
        ...baseServerDoc('srv-forward-2'),
        authProfileId: 'auth-prof-2',
        envProfileId: 'already-migrated-env',
      },
      {
        ...baseServerDoc('srv-noop'),
        authProfileId: null,
        envProfileId: null,
      },
    ]);

    const forwardFirst = await runMcpAuthProfileSplitMigration(db, {
      dryRun: false,
      restore: false,
      limit: null,
    });
    expect(forwardFirst.mode).toBe('forward');
    expect(forwardFirst.candidates).toBe(2);
    expect(forwardFirst.updated).toBe(2);

    const [forward1, forward2, untouched] = await Promise.all([
      db.collection('mcp_server_configs').findOne({ _id: 'srv-forward-1' }),
      db.collection('mcp_server_configs').findOne({ _id: 'srv-forward-2' }),
      db.collection('mcp_server_configs').findOne({ _id: 'srv-noop' }),
    ]);

    expect(forward1?.authProfileId).toBeNull();
    expect(forward1?.envProfileId).toBe('auth-prof-1');
    expect(forward2?.authProfileId).toBeNull();
    expect(forward2?.envProfileId).toBe('already-migrated-env');
    expect(untouched?.authProfileId).toBeNull();
    expect(untouched?.envProfileId).toBeNull();

    const forwardSecond = await runMcpAuthProfileSplitMigration(db, {
      dryRun: false,
      restore: false,
      limit: null,
    });
    expect(forwardSecond.candidates).toBe(0);
    expect(forwardSecond.updated).toBe(0);

    const restore = await runMcpAuthProfileSplitMigration(db, {
      dryRun: false,
      restore: true,
      limit: null,
    });
    expect(restore.mode).toBe('restore');
    expect(restore.candidates).toBe(2);
    expect(restore.updated).toBe(2);

    const [restored1, restored2] = await Promise.all([
      db.collection('mcp_server_configs').findOne({ _id: 'srv-forward-1' }),
      db.collection('mcp_server_configs').findOne({ _id: 'srv-forward-2' }),
    ]);

    expect(restored1?.authProfileId).toBe('auth-prof-1');
    expect(restored1?.envProfileId).toBeNull();
    expect(restored2?.authProfileId).toBe('already-migrated-env');
    expect(restored2?.envProfileId).toBeNull();

    const restoreSecond = await runMcpAuthProfileSplitMigration(db, {
      dryRun: false,
      restore: true,
      limit: null,
    });
    expect(restoreSecond.candidates).toBe(0);
    expect(restoreSecond.updated).toBe(0);
  });
});
