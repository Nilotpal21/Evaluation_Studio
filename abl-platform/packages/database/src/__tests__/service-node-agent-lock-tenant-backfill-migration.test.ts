import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { migration } from '../migrations/scripts/20260426_022_backfill_service_node_agent_lock_tenant_ids.js';

const PROJECTS_COLLECTION = 'projects';
const SERVICE_NODES_COLLECTION = 'service_nodes';
const AGENT_LOCKS_COLLECTION = 'agent_locks';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

describe('20260426_022 backfill tenantId on service nodes and agent locks', () => {
  test('backfills tenantId from the parent project and validates the result', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    await db.collection(PROJECTS_COLLECTION).insertMany([
      {
        _id: 'project-a',
        tenantId: 'tenant-a',
        name: 'Project A',
        slug: 'project-a',
        ownerId: 'user-a',
        kind: 'application',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: 'project-b',
        tenantId: 'tenant-b',
        name: 'Project B',
        slug: 'project-b',
        ownerId: 'user-b',
        kind: 'application',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await db.collection(SERVICE_NODES_COLLECTION).insertMany([
      {
        _id: 'service-node-1',
        projectId: 'project-a',
        name: 'service-a',
        displayName: 'Service A',
        description: null,
        endpoint: 'https://example.com/a',
        method: 'GET',
        authType: 'none',
        authConfig: null,
        encryptedSecrets: null,
        authProfileId: null,
        inputSchema: null,
        outputSchema: null,
        timeoutMs: 1000,
        retryCount: 1,
        retryDelayMs: 100,
        rateLimitPerMinute: null,
        rateLimitPerHour: null,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: 'service-node-2',
        tenantId: '',
        projectId: 'project-b',
        name: 'service-b',
        displayName: 'Service B',
        description: null,
        endpoint: 'https://example.com/b',
        method: 'POST',
        authType: 'none',
        authConfig: null,
        encryptedSecrets: null,
        authProfileId: null,
        inputSchema: null,
        outputSchema: null,
        timeoutMs: 1000,
        retryCount: 1,
        retryDelayMs: 100,
        rateLimitPerMinute: null,
        rateLimitPerHour: null,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await db.collection(AGENT_LOCKS_COLLECTION).insertMany([
      {
        _id: 'agent-lock-1',
        projectId: 'project-a',
        agentId: 'agent-a',
        agentName: 'Agent A',
        lockedBy: 'user-a',
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        lockType: 'edit',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: 'agent-lock-2',
        tenantId: null,
        projectId: 'project-b',
        agentId: 'agent-b',
        agentName: 'Agent B',
        lockedBy: 'user-b',
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        lockType: 'deploy',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await migration.up(db);

    const [serviceNode1, serviceNode2, agentLock1, agentLock2] = await Promise.all([
      db.collection(SERVICE_NODES_COLLECTION).findOne({ _id: 'service-node-1' }),
      db.collection(SERVICE_NODES_COLLECTION).findOne({ _id: 'service-node-2' }),
      db.collection(AGENT_LOCKS_COLLECTION).findOne({ _id: 'agent-lock-1' }),
      db.collection(AGENT_LOCKS_COLLECTION).findOne({ _id: 'agent-lock-2' }),
    ]);

    expect(serviceNode1?.tenantId).toBe('tenant-a');
    expect(serviceNode2?.tenantId).toBe('tenant-b');
    expect(agentLock1?.tenantId).toBe('tenant-a');
    expect(agentLock2?.tenantId).toBe('tenant-b');

    const validation = await migration.validate?.(db);
    expect(validation?.ok).toBe(true);
    expect(validation?.details).toEqual({
      serviceNodesRemaining: 0,
      agentLocksRemaining: 0,
    });
  });

  test('treats rollback as a safe no-op', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
