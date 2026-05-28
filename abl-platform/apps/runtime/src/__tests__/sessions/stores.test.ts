/**
 * Store Implementation Tests
 *
 * Integration tests for MongoConversationStore, MongoMessageStore,
 * MongoAgentRegistry, MongoFactStore, and factory functions using
 * mongodb-memory-server.
 *
 * IMPORTANT: All imports from @agent-platform/database/models and the
 * store modules that depend on them MUST be dynamic (inside beforeAll)
 * because the models barrel triggers an auto-connect on import.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { initDEKFacade } from '@agent-platform/database/kms';
import { runWithTenantContext } from '@agent-platform/shared';
import { setupTestMongo, teardownTestMongo, clearCollections } from '../helpers/setup-mongo.js';

// ---------------------------------------------------------------------------
// Lazy-loaded references (populated in beforeAll after Mongo is ready)
// ---------------------------------------------------------------------------

let MongoConversationStore: any;
let createMongoConversationStore: any;
let MongoMessageStore: any;
let createMongoMessageStore: any;
let MongoAgentRegistry: any;
let createMongoAgentRegistry: any;
let MongoFactStore: any;
let createMongoFactStore: any;
let SessionModel: any;
let MessageModel: any;
let ProjectAgentModel: any;

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-test-001';
const PROJECT_ID = 'project-test-001';

/** Run a callback inside tenant ALS context (required by withTenant fail-closed guard) */
function withTestTenant<T>(fn: () => T): T {
  return runWithTenantContext(
    {
      tenantId: TENANT_ID,
      userId: 'test-user',
      role: 'ADMIN',
      permissions: ['read', 'write'],
      authType: 'user',
      isSuperAdmin: false,
    },
    fn,
  );
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupTestMongo();

  const models = await import('@agent-platform/database/models');
  models.setMasterKey('ab'.repeat(32));
  await initDEKFacade({ masterKeyHex: 'ab'.repeat(32) });

  // Dynamic imports AFTER mongo is connected
  const convMod = await import('../../services/stores/mongo-conversation-store.js');
  MongoConversationStore = convMod.MongoConversationStore;
  createMongoConversationStore = convMod.createMongoConversationStore;

  const msgMod = await import('../../services/stores/mongo-message-store.js');
  MongoMessageStore = msgMod.MongoMessageStore;
  createMongoMessageStore = msgMod.createMongoMessageStore;

  const regMod = await import('../../services/stores/mongo-agent-registry.js');
  MongoAgentRegistry = regMod.MongoAgentRegistry;
  createMongoAgentRegistry = regMod.createMongoAgentRegistry;

  const factMod = await import('../../services/stores/mongo-fact-store.js');
  MongoFactStore = factMod.MongoFactStore;
  createMongoFactStore = factMod.createMongoFactStore;

  SessionModel = models.Session;
  MessageModel = models.Message;
  ProjectAgentModel = models.ProjectAgent;
}, 60_000);

afterEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  await teardownTestMongo();
}, 15_000);

// ===========================================================================
// MongoConversationStore
// ===========================================================================

describe('MongoConversationStore', () => {
  function makeStore() {
    return new MongoConversationStore({ type: 'mongodb' });
  }

  test('createSession', async () => {
    const store = makeStore();
    const session = await store.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'web',
      environment: 'dev',
      agentName: 'greeting_agent',
      agentVersion: '1.0.0',
      customerId: 'cust-1',
    });

    expect(session).toBeDefined();
    expect(session.id).toBeDefined();
    expect(session.channel).toBe('web');
    expect(session.status).toBe('active');
    expect(session.currentAgent).toBe('greeting_agent');
    expect(session.environment).toBe('dev');
    expect(session.startedAt).toBeInstanceOf(Date);
    expect(session.lastActivityAt).toBeInstanceOf(Date);
    expect(session.tenantId).toBe(TENANT_ID);
    expect(session.projectId).toBe(PROJECT_ID);
  });

  test('getSession', async () => {
    const store = makeStore();
    const created = await store.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'web_chat',
      environment: 'staging',
      agentName: 'support_agent',
      agentVersion: '2.0.0',
    });

    await withTestTenant(async () => {
      const fetched = await store.getSession(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.channel).toBe('web_chat');
      expect(fetched!.currentAgent).toBe('support_agent');

      // Non-existent session returns null
      const missing = await store.getSession('nonexistent-id');
      expect(missing).toBeNull();
    });
  });

  test('updateSession', async () => {
    const store = makeStore();
    const created = await store.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'web',
      environment: 'dev',
      agentName: 'agent_a',
      agentVersion: '1.0.0',
    });

    await withTestTenant(async () => {
      const updated = await store.updateSession(created.id, {
        currentAgent: 'agent_b',
        status: 'idle',
        context: { step: 'gather_info' },
        metadata: { source: 'test' },
      });

      expect(updated.currentAgent).toBe('agent_b');
      expect(updated.status).toBe('idle');
      expect(updated.context).toEqual({ step: 'gather_info' });
      expect(updated.metadata).toEqual({ source: 'test' });
      // lastActivityAt should be refreshed
      expect(updated.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
        created.lastActivityAt.getTime(),
      );

      // Updating non-existent session throws
      await expect(store.updateSession('nonexistent-id', { status: 'idle' })).rejects.toThrow(
        'Session not found',
      );
    });
  });

  test('endSession', async () => {
    const store = makeStore();
    const created = await store.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'voice',
      environment: 'production',
      agentName: 'voice_agent',
      agentVersion: '1.0.0',
    });

    await withTestTenant(async () => {
      const ended = await store.endSession(created.id, 'completed');
      expect(ended.status).toBe('ended');
      expect(ended.disposition).toBe('completed');
      expect(ended.endedAt).toBeInstanceOf(Date);

      // Ending non-existent session throws
      await expect(store.endSession('nonexistent-id', 'completed')).rejects.toThrow(
        'Session not found',
      );
    });
  });

  test('endSession keeps sessions with persisted messages when counters are still zero', async () => {
    const store = makeStore();
    const created = await store.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'web',
      environment: 'dev',
      agentName: 'race_agent',
      agentVersion: '1.0.0',
    });

    await MessageModel.collection.insertOne({
      _id: 'msg-race-1',
      sessionId: created.id,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      role: 'user',
      content: 'Hello before counter catch-up',
      channel: 'web',
    });

    await SessionModel.findOneAndUpdate(
      { _id: created.id, tenantId: TENANT_ID },
      {
        $set: {
          messageCount: 0,
          traceEventCount: 0,
          tokenCount: 0,
          errorCount: 0,
          handoffCount: 0,
        },
      },
    );

    await withTestTenant(async () => {
      const ended = await store.endSession(created.id, 'completed');
      expect(ended.status).toBe('ended');
      expect(ended.disposition).toBe('completed');

      const reloaded = await store.getSession(created.id);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.status).toBe('ended');
      expect(reloaded!.disposition).toBe('completed');
    });
  });

  test('cleanup', async () => {
    const store = makeStore();

    // Create a session and add a message so endSession persists (not ghost-deleted)
    const session = await store.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'web',
      environment: 'dev',
      agentName: 'cleanup_agent',
      agentVersion: '1.0.0',
    });
    await SessionModel.findByIdAndUpdate(session.id, { $inc: { messageCount: 1 } });

    await withTestTenant(async () => {
      await store.endSession(session.id, 'completed');

      // Backdate endedAt to make it eligible for cleanup
      await SessionModel.findByIdAndUpdate(session.id, {
        $set: { endedAt: new Date(Date.now() - 100_000) },
      });

      // Create another active session (should NOT be cleaned up)
      await store.createSession({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        channel: 'web',
        environment: 'dev',
        agentName: 'active_agent',
        agentVersion: '1.0.0',
      });

      // Cleanup sessions ended more than 50s ago
      const deleted = await store.cleanup(50_000);
      expect(deleted).toBe(1);
    });
  });
});

// ===========================================================================
// MongoMessageStore
// ===========================================================================

describe('MongoMessageStore', () => {
  function makeConversation() {
    return new MongoConversationStore({ type: 'mongodb' });
  }

  function makeStore() {
    return new MongoMessageStore({ type: 'mongodb' });
  }

  /** Helper: create a session so that addMessage can look up tenantId */
  async function createTestSession() {
    const conv = makeConversation();
    return conv.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'web',
      environment: 'dev',
      agentName: 'test_agent',
      agentVersion: '1.0.0',
    });
  }

  test('addMessage', async () => {
    const session = await createTestSession();
    const store = makeStore();

    const message = await store.addMessage({
      sessionId: session.id,
      role: 'user',
      content: 'Hello there!',
      channel: 'web',
      traceId: 'trace-001',
    });

    expect(message).toBeDefined();
    expect(message.id).toBeDefined();
    expect(message.sessionId).toBe(session.id);
    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello there!');
    expect(message.channel).toBe('web');
    expect(message.timestamp).toBeInstanceOf(Date);
    expect(message.traceId).toBe('trace-001');
  });

  test('getMessages', async () => {
    const session = await createTestSession();
    const store = makeStore();

    // Add multiple messages
    await store.addMessage({
      sessionId: session.id,
      role: 'user',
      content: 'Hello',
      channel: 'web',
      traceId: 'trace-001',
    });
    await store.addMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'Hi! How can I help?',
      channel: 'web',
      traceId: 'trace-001',
    });
    await store.addMessage({
      sessionId: session.id,
      role: 'system',
      content: 'System prompt',
      channel: 'web',
      traceId: 'trace-001',
    });

    // By default, system messages are excluded
    const noSystem = await store.getMessages({ sessionId: session.id, tenantId: TENANT_ID });
    expect(noSystem.length).toBe(2);
    expect(noSystem.every((m: any) => m.role !== 'system')).toBe(true);

    // Include system messages
    const withSystem = await store.getMessages({
      sessionId: session.id,
      tenantId: TENANT_ID,
      includeSystem: true,
    });
    expect(withSystem.length).toBe(3);

    // Filter by role
    const userOnly = await store.getMessages({
      sessionId: session.id,
      tenantId: TENANT_ID,
      roles: ['user'],
      includeSystem: true,
    });
    expect(userOnly.length).toBe(1);
    expect(userOnly[0].role).toBe('user');

    // Messages are returned in chronological order
    expect(withSystem[0].timestamp.getTime()).toBeLessThanOrEqual(
      withSystem[1].timestamp.getTime(),
    );

    // Limit and offset
    const limited = await store.getMessages({
      sessionId: session.id,
      tenantId: TENANT_ID,
      includeSystem: true,
      limit: 1,
      offset: 1,
    });
    expect(limited.length).toBe(1);
    expect(limited[0].role).toBe('assistant');
  });
});

// ===========================================================================
// MongoAgentRegistry
// ===========================================================================

describe('MongoAgentRegistry', () => {
  const REGISTRY_SCOPE = { tenantId: TENANT_ID, projectId: PROJECT_ID };

  function makeRegistry() {
    return new MongoAgentRegistry({ type: 'mongodb' }, REGISTRY_SCOPE);
  }

  /**
   * Helper: ensure the ProjectAgent document exists (with required agentPath)
   * then save a version via the registry.
   */
  async function ensureAgent(agentName: string) {
    const existing = await ProjectAgentModel.findOne({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: agentName,
    });
    if (!existing) {
      await ProjectAgentModel.create({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        name: agentName,
        agentPath: `${PROJECT_ID}/${agentName}`,
        dslContent: null,
        activeVersions: {},
      });
    }
  }

  async function seedVersion(
    registry: any,
    agentName: string,
    version: string,
    status: string = 'draft',
  ) {
    await ensureAgent(agentName);
    await registry.saveVersion({
      agentName,
      version,
      status,
      dslContent: `AGENT: ${agentName} v${version}
GOAL: "Handle agent tasks"`,
      irContent: JSON.stringify({ name: agentName, version }),
      sourceHash: `hash-${agentName}-${version}`,
      createdAt: new Date(),
      createdBy: 'test-user',
      changelog: `Version ${version}`,
    });
  }

  test('getVersion', async () => {
    const registry = makeRegistry();
    await seedVersion(registry, 'booking_agent', '1.0.0');

    const version = await registry.getVersion('booking_agent', '1.0.0');
    expect(version).not.toBeNull();
    expect(version!.agentName).toBe('booking_agent');
    expect(version!.version).toBe('1.0.0');
    expect(version!.status).toBe('draft');
    expect(version!.dslContent).toContain('booking_agent');
    expect(version!.sourceHash).toBe('hash-booking_agent-1.0.0');

    // Non-existent version returns null
    const missing = await registry.getVersion('booking_agent', '9.9.9');
    expect(missing).toBeNull();

    // Non-existent agent returns null
    const noAgent = await registry.getVersion('nonexistent_agent', '1.0.0');
    expect(noAgent).toBeNull();
  });

  test('saveVersion refreshes parent ProjectAgent DSL validation metadata', async () => {
    const registry = makeRegistry();

    await ProjectAgentModel.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: 'metadata_agent',
      agentPath: `${PROJECT_ID}/metadata_agent`,
      dslContent: 'AGENT: metadata_agent\nGOAL: "Stale"',
      sourceHash: 'stale-parent-hash',
      dslValidationStatus: null,
      dslDiagnostics: [{ severity: 'error', message: 'stale diagnostic' }],
      activeVersions: {},
    });

    await registry.saveVersion({
      agentName: 'metadata_agent',
      version: '1.0.0',
      status: 'draft',
      dslContent: 'AGENT: metadata_agent\nGOAL: "Handle metadata refresh"',
      irContent: JSON.stringify({ name: 'metadata_agent' }),
      sourceHash: 'version-hash',
      createdAt: new Date(),
      createdBy: 'test-user',
      changelog: 'Refresh parent metadata',
    });

    const parent = await ProjectAgentModel.findOne({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: 'metadata_agent',
    }).lean();

    expect(parent?.dslContent).toBe('AGENT: metadata_agent\nGOAL: "Handle metadata refresh"');
    expect(parent?.sourceHash).toEqual(expect.any(String));
    expect(parent?.sourceHash).not.toBe('stale-parent-hash');
    expect(parent?.dslValidationStatus).toBe('valid');
    expect(parent?.dslDiagnostics).toEqual([]);
  });

  test('getActiveVersion', async () => {
    const registry = makeRegistry();
    await seedVersion(registry, 'deploy_agent', '1.0.0', 'active');

    // No active version set yet
    const none = await registry.getActiveVersion('deploy_agent', 'dev');
    expect(none).toBeNull();

    // Set active version
    await registry.setActiveVersion('deploy_agent', '1.0.0', 'dev');
    const active = await registry.getActiveVersion('deploy_agent', 'dev');
    expect(active).toBe('1.0.0');

    // Different environment should still be null
    const stagingActive = await registry.getActiveVersion('deploy_agent', 'staging');
    expect(stagingActive).toBeNull();
  });

  test('setActiveVersion', async () => {
    const registry = makeRegistry();
    await seedVersion(registry, 'promo_agent', '1.0.0');
    await seedVersion(registry, 'promo_agent', '2.0.0');

    await registry.setActiveVersion('promo_agent', '1.0.0', 'dev');
    expect(await registry.getActiveVersion('promo_agent', 'dev')).toBe('1.0.0');

    // Overwrite with a new version
    await registry.setActiveVersion('promo_agent', '2.0.0', 'dev');
    expect(await registry.getActiveVersion('promo_agent', 'dev')).toBe('2.0.0');

    // Set a different environment independently
    await registry.setActiveVersion('promo_agent', '1.0.0', 'staging');
    expect(await registry.getActiveVersion('promo_agent', 'staging')).toBe('1.0.0');
    // dev should still be 2.0.0
    expect(await registry.getActiveVersion('promo_agent', 'dev')).toBe('2.0.0');
  });

  test('getActiveVersions', async () => {
    const registry = makeRegistry();
    await seedVersion(registry, 'multi_env_agent', '1.0.0');
    await seedVersion(registry, 'multi_env_agent', '2.0.0');

    await registry.setActiveVersion('multi_env_agent', '1.0.0', 'dev');
    await registry.setActiveVersion('multi_env_agent', '2.0.0', 'staging');

    const versions = await registry.getActiveVersions('multi_env_agent');
    expect(versions.dev).toBe('1.0.0');
    expect(versions.staging).toBe('2.0.0');

    // Non-existent agent returns empty object
    const empty = await registry.getActiveVersions('nonexistent_agent');
    expect(empty).toEqual({});
  });

  test('listAgents', async () => {
    const registry = makeRegistry();

    // Initially empty
    const emptyList = await registry.listAgents();
    expect(emptyList).toEqual([]);

    await seedVersion(registry, 'agent_alpha', '1.0.0');
    await seedVersion(registry, 'agent_beta', '1.0.0');
    await seedVersion(registry, 'agent_alpha', '2.0.0'); // duplicate agent name

    const agents = await registry.listAgents();
    expect(agents.sort()).toEqual(['agent_alpha', 'agent_beta']);
  });

  test('queryVersions', async () => {
    const registry = makeRegistry();
    await seedVersion(registry, 'query_agent', '1.0.0', 'draft');
    await seedVersion(registry, 'query_agent', '2.0.0', 'active');
    await seedVersion(registry, 'other_agent', '1.0.0', 'draft');

    // Query all
    const all = await registry.queryVersions({});
    expect(all.length).toBe(3);

    // Query by agent name
    const forAgent = await registry.queryVersions({
      agentName: 'query_agent',
    });
    expect(forAgent.length).toBe(2);
    expect(forAgent.every((v: any) => v.agentName === 'query_agent')).toBe(true);

    // Query by status
    const drafts = await registry.queryVersions({ status: 'draft' });
    expect(drafts.length).toBe(2);
    expect(drafts.every((v: any) => v.status === 'draft')).toBe(true);

    // Query by name + status
    const activeQuery = await registry.queryVersions({
      agentName: 'query_agent',
      status: 'active',
    });
    expect(activeQuery.length).toBe(1);
    expect(activeQuery[0].version).toBe('2.0.0');
  });

  test('getVersionHistory', async () => {
    const registry = makeRegistry();
    await seedVersion(registry, 'history_agent', '1.0.0');
    // Small delay so createdAt ordering is deterministic
    await new Promise((r) => setTimeout(r, 50));
    await seedVersion(registry, 'history_agent', '2.0.0');
    await new Promise((r) => setTimeout(r, 50));
    await seedVersion(registry, 'history_agent', '3.0.0');

    // Full history (most recent first)
    const history = await registry.getVersionHistory('history_agent');
    expect(history.length).toBe(3);
    expect(history[0].version).toBe('3.0.0');
    expect(history[2].version).toBe('1.0.0');

    // Limited history
    const limited = await registry.getVersionHistory('history_agent', 2);
    expect(limited.length).toBe(2);
    expect(limited[0].version).toBe('3.0.0');

    // Non-existent agent returns empty
    const none = await registry.getVersionHistory('nonexistent');
    expect(none).toEqual([]);
  });

  test('scopes all agent registry operations by tenant and project', async () => {
    const otherTenantId = 'tenant-test-other';
    const registry = makeRegistry();
    const otherTenantRegistry = new MongoAgentRegistry(
      { type: 'mongodb' },
      { tenantId: otherTenantId, projectId: PROJECT_ID },
    );

    await ProjectAgentModel.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: 'shared_agent',
      agentPath: `${PROJECT_ID}/shared_agent`,
      dslContent: null,
      activeVersions: {},
    });
    await ProjectAgentModel.create({
      tenantId: otherTenantId,
      projectId: PROJECT_ID,
      name: 'shared_agent',
      agentPath: `${PROJECT_ID}/shared_agent`,
      dslContent: null,
      activeVersions: {},
    });

    await registry.saveVersion({
      agentName: 'shared_agent',
      version: '1.0.0',
      status: 'active',
      dslContent: 'AGENT: shared_agent\nGOAL: "Tenant one"',
      irContent: JSON.stringify({ name: 'shared_agent', tenant: TENANT_ID }),
      sourceHash: 'tenant-one-hash',
      createdAt: new Date(),
      createdBy: 'test-user',
      changelog: 'Tenant one version',
    });
    await otherTenantRegistry.saveVersion({
      agentName: 'shared_agent',
      version: '2.0.0',
      status: 'active',
      dslContent: 'AGENT: shared_agent\nGOAL: "Tenant two"',
      irContent: JSON.stringify({ name: 'shared_agent', tenant: otherTenantId }),
      sourceHash: 'tenant-two-hash',
      createdAt: new Date(),
      createdBy: 'test-user',
      changelog: 'Tenant two version',
    });

    await registry.setActiveVersion('shared_agent', '1.0.0', 'dev');
    await otherTenantRegistry.setActiveVersion('shared_agent', '2.0.0', 'dev');

    await expect(registry.getVersion('shared_agent', '2.0.0')).resolves.toBeNull();
    await expect(otherTenantRegistry.getVersion('shared_agent', '1.0.0')).resolves.toBeNull();

    expect(await registry.getActiveVersion('shared_agent', 'dev')).toBe('1.0.0');
    expect(await otherTenantRegistry.getActiveVersion('shared_agent', 'dev')).toBe('2.0.0');

    const tenantOneVersions = await registry.queryVersions({});
    expect(tenantOneVersions).toHaveLength(1);
    expect(tenantOneVersions[0].version).toBe('1.0.0');

    const tenantTwoVersions = await otherTenantRegistry.queryVersions({});
    expect(tenantTwoVersions).toHaveLength(1);
    expect(tenantTwoVersions[0].version).toBe('2.0.0');
  });
});

// ===========================================================================
// MongoFactStore
// ===========================================================================

describe('MongoFactStore', () => {
  function makeStore() {
    return new MongoFactStore({ type: 'mongodb' });
  }

  test('set', async () => {
    const store = makeStore();

    const fact = await store.set({
      key: 'user.preferences.language',
      value: 'en',
      source: { type: 'agent', agentName: 'onboarding' },
    });

    expect(fact).toBeDefined();
    expect(fact.id).toBeDefined();
    expect(fact.key).toBe('user.preferences.language');
    expect(fact.value).toBe('en');
    expect(fact.source.type).toBe('agent');
    expect(fact.source.agentName).toBe('onboarding');
    expect(fact.createdAt).toBeInstanceOf(Date);
    expect(fact.updatedAt).toBeInstanceOf(Date);
    expect(fact.expiresAt).toBeNull();
  });

  test('set — upsert overwrites existing key', async () => {
    const store = makeStore();

    await store.set({ key: 'counter', value: 1 });
    const updated = await store.set({ key: 'counter', value: 2 });

    expect(updated.value).toBe(2);

    // Only one document in the collection for this key
    const results = await store.query({ prefix: 'counter' });
    expect(results.length).toBe(1);
  });

  test('set — with TTL', async () => {
    const store = makeStore();

    const fact = await store.set({
      key: 'temp.token',
      value: 'abc123',
      ttlMs: 60_000,
    });

    expect(fact.expiresAt).toBeInstanceOf(Date);
    expect(fact.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test('get', async () => {
    const store = makeStore();
    await store.set({ key: 'greeting', value: 'Hello world' });

    const fact = await store.get({ key: 'greeting' });
    expect(fact).not.toBeNull();
    expect(fact!.key).toBe('greeting');
    expect(fact!.value).toBe('Hello world');

    // Non-existent key returns null
    const missing = await store.get({ key: 'nonexistent' });
    expect(missing).toBeNull();
  });

  test('get — expired facts return null', async () => {
    const store = makeStore();

    // Set a fact with a very short TTL
    await store.set({
      key: 'ephemeral',
      value: 'short-lived',
      ttlMs: 1, // 1ms TTL
    });

    // Wait for it to expire
    await new Promise((r) => setTimeout(r, 50));

    const result = await store.get({ key: 'ephemeral' });
    expect(result).toBeNull();
  });

  test('delete', async () => {
    const store = makeStore();
    await store.set({ key: 'to-delete', value: 'bye' });

    const deleted = await store.delete('to-delete');
    expect(deleted).toBe(true);

    const afterDelete = await store.get({ key: 'to-delete' });
    expect(afterDelete).toBeNull();

    // Deleting non-existent key returns false
    const notFound = await store.delete('nonexistent');
    expect(notFound).toBe(false);
  });

  test('exists', async () => {
    const store = makeStore();
    await store.set({ key: 'check-exists', value: true });

    expect(await store.exists('check-exists')).toBe(true);
    expect(await store.exists('does-not-exist')).toBe(false);
  });

  test('exists — expired facts return false', async () => {
    const store = makeStore();

    await store.set({
      key: 'exp-exists',
      value: 'temp',
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(await store.exists('exp-exists')).toBe(false);
  });

  test('query', async () => {
    const store = makeStore();
    await store.set({
      key: 'user.123.name',
      value: 'Alice',
      source: { type: 'user' },
    });
    await store.set({
      key: 'user.123.email',
      value: 'alice@example.com',
      source: { type: 'user' },
    });
    await store.set({
      key: 'user.456.name',
      value: 'Bob',
      source: { type: 'agent', agentName: 'profile_agent' },
    });
    await store.set({
      key: 'system.version',
      value: '2.0',
      source: { type: 'system' },
    });

    // Query by prefix
    const user123 = await store.query({ prefix: 'user.123.' });
    expect(user123.length).toBe(2);
    expect(user123.every((f: any) => f.key.startsWith('user.123.'))).toBe(true);

    // Query by pattern (glob)
    const allNames = await store.query({ pattern: 'user.*.name' });
    expect(allNames.length).toBe(2);

    // Query by source type
    const agentFacts = await store.query({ sourceType: 'agent' });
    expect(agentFacts.length).toBe(1);
    expect(agentFacts[0].key).toBe('user.456.name');

    // Query with limit
    const limited = await store.query({ prefix: 'user.', limit: 1 });
    expect(limited.length).toBe(1);
  });

  test('batchSet', async () => {
    const store = makeStore();

    const facts = await store.batchSet({
      facts: [
        { key: 'batch.a', value: 1 },
        { key: 'batch.b', value: 2 },
        { key: 'batch.c', value: 3 },
      ],
      defaultSource: { type: 'system' },
    });

    expect(facts.length).toBe(3);
    const keys = facts.map((f: any) => f.key).sort();
    expect(keys).toEqual(['batch.a', 'batch.b', 'batch.c']);

    // Verify the values were persisted
    const a = await store.get({ key: 'batch.a' });
    expect(a!.value).toBe(1);
  });

  test('batchDelete', async () => {
    const store = makeStore();
    await store.batchSet({
      facts: [
        { key: 'del.a', value: 1 },
        { key: 'del.b', value: 2 },
        { key: 'del.c', value: 3 },
      ],
    });

    const deleted = await store.batchDelete(['del.a', 'del.b']);
    expect(deleted).toBe(2);

    // del.c should still exist
    expect(await store.exists('del.c')).toBe(true);
    expect(await store.exists('del.a')).toBe(false);
  });

  test('clear', async () => {
    const store = makeStore();
    await store.batchSet({
      facts: [
        { key: 'clear.x', value: 'x' },
        { key: 'clear.y', value: 'y' },
      ],
    });

    const cleared = await store.clear();
    expect(cleared).toBe(2);

    const remaining = await store.query({});
    expect(remaining.length).toBe(0);
  });

  test('cleanup', async () => {
    const store = makeStore();

    // Create a fact with very short TTL
    await store.set({
      key: 'cleanup.expired',
      value: 'old',
      ttlMs: 1,
    });
    // Create a fact without TTL
    await store.set({
      key: 'cleanup.permanent',
      value: 'stays',
    });

    // Wait for the TTL to expire
    await new Promise((r) => setTimeout(r, 50));

    const cleaned = await store.cleanup();
    expect(cleaned).toBe(1);

    // Permanent fact is still there
    expect(await store.exists('cleanup.permanent')).toBe(true);
  });
});

// ===========================================================================
// Factory functions
// ===========================================================================

describe('Factory functions', () => {
  test('createMongoConversationStore', async () => {
    const store = createMongoConversationStore();
    expect(store).toBeInstanceOf(MongoConversationStore);

    // Verify it works by creating a session
    const session = await store.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'api',
      environment: 'dev',
      agentName: 'factory_agent',
      agentVersion: '1.0.0',
    });
    expect(session.id).toBeDefined();
    expect(session.status).toBe('active');
  });

  test('createMongoMessageStore', async () => {
    const store = createMongoMessageStore();
    expect(store).toBeInstanceOf(MongoMessageStore);

    // Create a session first (needed for tenantId lookup in addMessage)
    const convStore = createMongoConversationStore();
    const session = await convStore.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'web',
      environment: 'dev',
      agentName: 'factory_msg_agent',
      agentVersion: '1.0.0',
    });

    const message = await store.addMessage({
      sessionId: session.id,
      role: 'user',
      content: 'Factory message',
      channel: 'web',
      traceId: 'trace-factory',
    });
    expect(message.id).toBeDefined();
    expect(message.content).toBe('Factory message');
  });

  test('createMongoAgentRegistry', async () => {
    const registry = createMongoAgentRegistry({ tenantId: TENANT_ID, projectId: PROJECT_ID });
    expect(registry).toBeInstanceOf(MongoAgentRegistry);

    // Pre-create the ProjectAgent with required agentPath
    await ProjectAgentModel.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: 'factory_reg_agent',
      agentPath: `${PROJECT_ID}/factory_reg_agent`,
      dslContent: null,
      activeVersions: {},
    });

    // Verify it works
    await registry.saveVersion({
      agentName: 'factory_reg_agent',
      version: '1.0.0',
      status: 'draft',
      dslContent: 'AGENT: factory_reg_agent',
      irContent: '{}',
      sourceHash: 'abc123',
      createdAt: new Date(),
      createdBy: 'test',
    });

    const agents = await registry.listAgents();
    expect(agents).toContain('factory_reg_agent');
  });

  test('createMongoFactStore', async () => {
    const store = createMongoFactStore();
    expect(store).toBeInstanceOf(MongoFactStore);

    // Verify it works
    const fact = await store.set({
      key: 'factory.fact',
      value: 42,
      source: { type: 'system' },
    });
    expect(fact.key).toBe('factory.fact');
    expect(fact.value).toBe(42);
  });
});
