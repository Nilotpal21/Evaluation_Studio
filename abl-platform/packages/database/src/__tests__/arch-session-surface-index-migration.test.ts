import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { migration as scopeArchSessionsToSurface } from '../migrations/scripts/20260512_033_scope_arch_sessions_to_surface.js';

const COLLECTION = 'arch_sessions';
const LEGACY_UNIQUE_INDEX_NAME = 'tenantId_1_userId_1_metadata.mode_1_metadata.projectId_1';
const LEGACY_LOOKUP_INDEX_NAME = 'tenantId_1_userId_1_metadata.mode_1_metadata.projectId_1_state_1';
const CANONICAL_UNIQUE_INDEX_NAME = 'arch_session_scope_thread_unique_v1';

function makeSessionDoc(
  id: string,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = new Date('2026-05-12T00:00:00.000Z');
  return {
    _id: id,
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'IDLE',
    metadata: {
      phase: 'INTERVIEW',
      mode: 'IN_PROJECT',
      projectId: 'project-1',
      specification: {},
      pendingInteraction: null,
      messages: [],
      ...metadata,
    },
    createdAt: now,
    updatedAt: now,
  };
}

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  if (!isMongoReady()) return;

  const db = mongoose.connection.db!;
  const collections = await db.listCollections({ name: COLLECTION }).toArray();
  if (collections.length > 0) {
    await db.dropCollection(COLLECTION);
  }
});

describe('20260512_033 Arch session surface/thread uniqueness migration', () => {
  test('replaces legacy project uniqueness with surface and thread scoped uniqueness', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const sessions = db.collection(COLLECTION);

    await sessions.insertOne(makeSessionDoc('project-session'));
    await sessions.createIndex(
      { tenantId: 1, userId: 1, 'metadata.mode': 1, 'metadata.projectId': 1, state: 1 },
      { name: LEGACY_LOOKUP_INDEX_NAME },
    );
    await sessions.createIndex(
      { tenantId: 1, userId: 1, 'metadata.mode': 1, 'metadata.projectId': 1 },
      {
        unique: true,
        name: LEGACY_UNIQUE_INDEX_NAME,
        partialFilterExpression: { state: { $in: ['IDLE', 'ACTIVE', 'GATE_PENDING'] } },
      },
    );

    await expect(
      sessions.insertOne(
        makeSessionDoc('editor-session-before', {
          surface: 'agent-editor',
          agentName: 'BookingRequestAgent',
          agentNameKey: Buffer.from('bookingrequestagent', 'utf8').toString('base64url'),
        }),
      ),
    ).rejects.toThrow(/duplicate key/);

    await scopeArchSessionsToSurface.up(db);

    const indexes = await sessions.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: {
            tenantId: 1,
            userId: 1,
            'metadata.mode': 1,
            'metadata.projectId': 1,
            'metadata.surface': 1,
            'metadata.agentNameKey': 1,
            'metadata.threadId': 1,
          },
          name: CANONICAL_UNIQUE_INDEX_NAME,
          unique: true,
        }),
      ]),
    );
    expect(indexes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { tenantId: 1, userId: 1, 'metadata.mode': 1, 'metadata.projectId': 1 },
          unique: true,
        }),
      ]),
    );

    const backfilledProjectSession = await sessions.findOne({ _id: 'project-session' });
    expect(backfilledProjectSession?.metadata).toMatchObject({
      contractVersion: 3,
      surface: 'project',
      agentName: null,
      agentNameKey: '__project__',
      threadId: '__default__',
    });

    await expect(
      sessions.insertOne(
        makeSessionDoc('editor-session-after', {
          surface: 'agent-editor',
          agentName: 'BookingRequestAgent',
          agentNameKey: Buffer.from('bookingrequestagent', 'utf8').toString('base64url'),
          threadId: '__default__',
        }),
      ),
    ).resolves.toBeDefined();

    await expect(
      sessions.insertOne(
        makeSessionDoc('project-session-duplicate', {
          surface: 'project',
          agentName: null,
          agentNameKey: '__project__',
          threadId: '__default__',
        }),
      ),
    ).rejects.toThrow(/duplicate key/);

    await expect(
      sessions.insertOne(
        makeSessionDoc('project-session-new-thread', {
          surface: 'project',
          agentName: null,
          agentNameKey: '__project__',
          threadId: 'thread-2',
        }),
      ),
    ).resolves.toBeDefined();

    const validation = await scopeArchSessionsToSurface.validate?.(db);
    expect(validation?.ok).toBe(true);
    expect(validation?.details).toMatchObject({
      canonicalLookupPresent: true,
      canonicalUniquePresent: true,
      legacyUniqueIndexes: [],
      surfaceUniqueIndexes: [],
    });
  });
});
