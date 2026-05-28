/**
 * Store Factory & Store Implementation Unit Tests
 *
 * Tests for getStores() singleton, MongoConversationStore, and MongoMessageStore
 * using mocked Mongoose models (no MongoMemoryServer).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// MOCK SETUP — must be before any imports of the tested modules
// =============================================================================

// ---------------------------------------------------------------------------
// Mock: @agent-platform/database/models
// ---------------------------------------------------------------------------

const mockSessionCreate = vi.fn();
const mockSessionFindById = vi.fn();
const mockSessionFindByIdAndUpdate = vi.fn();
const mockSessionFindByIdAndDelete = vi.fn();
const mockSessionFindOne = vi.fn();
const mockSessionFindOneAndUpdate = vi.fn();
const mockSessionFindOneAndDelete = vi.fn();
const mockSessionFind = vi.fn();
const mockSessionCountDocuments = vi.fn();
const mockSessionDeleteMany = vi.fn();

const mockMessageCreate = vi.fn();
const mockMessageFind = vi.fn();
const mockMessageCountDocuments = vi.fn();
const mockMessageDeleteMany = vi.fn();
const mockMessageExists = vi.fn().mockResolvedValue(null);

// Chain helpers for Mongoose query builder pattern
function chainable(result: any) {
  const chain: any = {
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(result),
    then: undefined as any,
  };
  // Make the chain thenable so `await` resolves .lean() automatically
  chain.then = (resolve: any, reject: any) => chain.lean().then(resolve, reject);
  return chain;
}

vi.mock('@agent-platform/database/models', () => ({
  Session: {
    create: (...args: any[]) => mockSessionCreate(...args),
    findById: (...args: any[]) => mockSessionFindById(...args),
    findByIdAndUpdate: (...args: any[]) => mockSessionFindByIdAndUpdate(...args),
    findByIdAndDelete: (...args: any[]) => mockSessionFindByIdAndDelete(...args),
    findOne: (...args: any[]) => mockSessionFindOne(...args),
    findOneAndUpdate: (...args: any[]) => mockSessionFindOneAndUpdate(...args),
    findOneAndDelete: (...args: any[]) => mockSessionFindOneAndDelete(...args),
    find: (...args: any[]) => mockSessionFind(...args),
    countDocuments: (...args: any[]) => mockSessionCountDocuments(...args),
    deleteMany: (...args: any[]) => mockSessionDeleteMany(...args),
  },
  Message: {
    create: (...args: any[]) => mockMessageCreate(...args),
    find: (...args: any[]) => mockMessageFind(...args),
    countDocuments: (...args: any[]) => mockMessageCountDocuments(...args),
    deleteMany: (...args: any[]) => mockMessageDeleteMany(...args),
    exists: (...args: any[]) => mockMessageExists(...args),
  },
  Subscription: {
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    }),
  },
  Project: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
  Attachment: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    exists: vi.fn().mockResolvedValue(null),
  },
}));

// ---------------------------------------------------------------------------
// Mock: @agent-platform/database/mongo
// ---------------------------------------------------------------------------

vi.mock('@agent-platform/database/cascade', () => ({
  deleteSession: vi.fn().mockResolvedValue({ counts: {}, total: 0, anonymized: {} }),
}));

vi.mock('@agent-platform/database/mongo', () => ({
  withTenantContext: vi.fn((_ctx: any, fn: () => any) => fn()),
}));

// ---------------------------------------------------------------------------
// Mock: @agent-platform/shared
// ---------------------------------------------------------------------------

vi.mock('@agent-platform/shared-auth/middleware', () => ({
  getCurrentTenantId: vi.fn(() => 'tenant-unit-001'),
}));

// ---------------------------------------------------------------------------
// Mock: encryption service (used by store-factory.ts via require)
// ---------------------------------------------------------------------------

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => undefined),
  isEncryptionAvailable: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Mock: sibling store factories (used by store-factory.ts)
// ---------------------------------------------------------------------------

vi.mock('../services/stores/mongo-contact-store.js', () => ({
  createMongoContactStore: vi.fn(() => ({ _type: 'contact' })),
}));

vi.mock('../services/stores/mongo-fact-store.js', () => ({
  createMongoFactStore: vi.fn(() => ({ _type: 'fact' })),
}));

vi.mock('../services/stores/mongo-workflow-definition-store.js', () => ({
  createMongoWorkflowDefinitionStore: vi.fn(() => ({ _type: 'workflowDefinition' })),
}));

vi.mock('../services/stores/mongo-agent-registry.js', () => ({
  createMongoAgentRegistry: vi.fn((scope: { tenantId: string; projectId: string }) => ({
    _type: 'agentRegistry',
    tenantId: scope.tenantId,
    projectId: scope.projectId,
  })),
}));

// =============================================================================
// IMPORTS — after mocks are registered
// =============================================================================

import {
  MongoConversationStore,
  createMongoConversationStore,
} from '../services/stores/mongo-conversation-store.js';
import {
  MongoMessageStore,
  createMongoMessageStore,
} from '../services/stores/mongo-message-store.js';
import { withTenantContext } from '@agent-platform/database/mongo';
import { getCurrentTenantId } from '@agent-platform/shared-auth/middleware';

// =============================================================================
// HELPERS
// =============================================================================

const NOW = new Date('2026-01-15T10:00:00Z');

function makeSessionDoc(overrides: Record<string, any> = {}) {
  return {
    _id: 'session-001',
    tenantId: 'tenant-unit-001',
    projectId: 'project-001',
    customerId: 'customer-001',
    anonymousId: null,
    channel: 'web',
    channelHistory: ['web'],
    status: 'active',
    currentAgent: 'greeting_agent',
    agentVersion: '1.0.0',
    environment: 'production',
    context: {},
    metadata: {},
    startedAt: NOW,
    lastActivityAt: NOW,
    endedAt: null,
    disposition: null,
    dispositionCode: null,
    contactId: null,
    callerNumber: null,
    initiatedById: null,
    workflowId: null,
    workflowStepId: null,
    parentId: null,
    callDuration: null,
    archivedAt: null,
    messageCount: 5,
    ...overrides,
  };
}

function makeMessageDoc(overrides: Record<string, any> = {}) {
  return {
    _id: 'msg-001',
    sessionId: 'session-001',
    tenantId: 'tenant-unit-001',
    role: 'user',
    content: 'Hello!',
    channel: 'web',
    traceId: 'trace-001',
    metadata: {},
    timestamp: NOW,
    encrypted: false,
    ...overrides,
  };
}

function resetAllMocks() {
  vi.clearAllMocks();
}

// =============================================================================
// TESTS
// =============================================================================

beforeEach(() => {
  resetAllMocks();
  mockMessageFind.mockReturnValue(chainable([makeMessageDoc()]));
});

// ---------------------------------------------------------------------------
// getStores() — singleton behavior
// ---------------------------------------------------------------------------

describe('getStores()', () => {
  // We need to reset modules per test to reset the singleton
  test('returns an object with all required store properties', async () => {
    // Re-import to get a fresh singleton
    const { getStores } = await import('../services/stores/store-factory.js');
    const stores = getStores();

    expect(stores).toBeDefined();
    expect(stores.conversation).toBeDefined();
    expect(stores.message).toBeDefined();
    expect(stores.contact).toBeDefined();
    expect(stores.fact).toBeDefined();
    expect(stores.workflowDefinition).toBeDefined();
    expect(typeof stores.createAgentRegistry).toBe('function');
  });

  test('returns the same instance on multiple calls (singleton)', async () => {
    vi.resetModules();

    // Re-register mocks after resetModules
    vi.doMock('@agent-platform/database/models', () => ({
      Session: { create: vi.fn(), findById: vi.fn() },
      Message: { create: vi.fn(), find: vi.fn(), exists: vi.fn().mockResolvedValue(null) },
    }));
    vi.doMock('@agent-platform/database/mongo', () => ({
      withTenantContext: vi.fn((_ctx: any, fn: () => any) => fn()),
    }));
    vi.doMock('@agent-platform/shared-auth/middleware', () => ({
      getCurrentTenantId: vi.fn(() => null),
    }));
    vi.doMock('@agent-platform/shared/encryption', () => ({
      getEncryptionService: vi.fn(() => undefined),
      isEncryptionAvailable: vi.fn(() => false),
    }));
    vi.doMock('../services/stores/mongo-contact-store.js', () => ({
      createMongoContactStore: vi.fn(() => ({ _type: 'contact' })),
    }));
    vi.doMock('../services/stores/mongo-fact-store.js', () => ({
      createMongoFactStore: vi.fn(() => ({ _type: 'fact' })),
    }));
    vi.doMock('../services/stores/mongo-workflow-definition-store.js', () => ({
      createMongoWorkflowDefinitionStore: vi.fn(() => ({ _type: 'workflowDefinition' })),
    }));
    vi.doMock('../services/stores/mongo-agent-registry.js', () => ({
      createMongoAgentRegistry: vi.fn((scope: { tenantId: string; projectId: string }) => ({
        _type: 'agentRegistry',
        tenantId: scope.tenantId,
        projectId: scope.projectId,
      })),
    }));

    const { getStores } = await import('../services/stores/store-factory.js');
    const first = getStores();
    const second = getStores();
    const third = getStores();

    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  test('createAgentRegistry returns a new registry per call', async () => {
    const { getStores } = await import('../services/stores/store-factory.js');
    const stores = getStores();

    const reg1 = stores.createAgentRegistry({ tenantId: 'tenant-a', projectId: 'project-a' });
    const reg2 = stores.createAgentRegistry({ tenantId: 'tenant-b', projectId: 'project-b' });

    expect(reg1).not.toBe(reg2);
    expect((reg1 as any).tenantId).toBe('tenant-a');
    expect((reg1 as any).projectId).toBe('project-a');
    expect((reg2 as any).tenantId).toBe('tenant-b');
    expect((reg2 as any).projectId).toBe('project-b');
  });

  test('createAgentRegistry returns distinct instances for same project', async () => {
    const { getStores } = await import('../services/stores/store-factory.js');
    const stores = getStores();

    const scope = { tenantId: 'tenant-a', projectId: 'project-a' };
    const reg1 = stores.createAgentRegistry(scope);
    const reg2 = stores.createAgentRegistry(scope);

    // Each call creates a new instance
    expect(reg1).not.toBe(reg2);
  });
});

// ---------------------------------------------------------------------------
// MongoConversationStore
// ---------------------------------------------------------------------------

describe('MongoConversationStore', () => {
  function makeStore() {
    return new MongoConversationStore({ type: 'mongodb' });
  }

  // ── createSession ──────────────────────────────────────────────────────

  describe('createSession', () => {
    test('creates a session with all provided params', async () => {
      const doc = makeSessionDoc();
      mockSessionCreate.mockResolvedValue(doc);

      const store = makeStore();
      const session = await store.createSession({
        tenantId: 'tenant-unit-001',
        projectId: 'project-001',
        channel: 'web',
        environment: 'production',
        agentName: 'greeting_agent',
        agentVersion: '1.0.0',
        customerId: 'customer-001',
      });

      expect(session).toBeDefined();
      expect(session.id).toBe('session-001');
      expect(session.channel).toBe('web');
      expect(session.status).toBe('active');
      expect(session.currentAgent).toBe('greeting_agent');
      expect(session.environment).toBe('production');
      expect(session.tenantId).toBe('tenant-unit-001');
      expect(session.projectId).toBe('project-001');
      expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    });

    test('passes metadata through to SessionModel.create', async () => {
      const doc = makeSessionDoc({ metadata: { source: 'api' } });
      mockSessionCreate.mockResolvedValue(doc);

      const store = makeStore();
      await store.createSession({
        tenantId: 'tenant-unit-001',
        projectId: 'project-001',
        channel: 'web',
        environment: 'production',
        agentName: 'test_agent',
        agentVersion: '1.0.0',
        metadata: { source: 'api' },
      });

      const createArg = mockSessionCreate.mock.calls[0][0];
      expect(createArg.metadata).toEqual({ source: 'api' });
    });

    test('defaults environment to production when not provided', async () => {
      const doc = makeSessionDoc({ environment: 'production' });
      mockSessionCreate.mockResolvedValue(doc);

      const store = makeStore();
      await store.createSession({
        tenantId: 'tenant-unit-001',
        projectId: 'project-001',
        channel: 'web',
        agentName: 'test_agent',
        agentVersion: '1.0.0',
        // no environment
      } as any);

      const createArg = mockSessionCreate.mock.calls[0][0];
      expect(createArg.environment).toBe('production');
    });

    test('includes id and deploymentId when provided', async () => {
      const doc = makeSessionDoc();
      mockSessionCreate.mockResolvedValue(doc);

      const store = makeStore();
      await store.createSession({
        tenantId: 'tenant-unit-001',
        projectId: 'project-001',
        channel: 'web',
        environment: 'dev',
        agentName: 'test_agent',
        agentVersion: '1.0.0',
        id: 'rt-session-123',
        deploymentId: 'deploy-456',
      });

      const createArg = mockSessionCreate.mock.calls[0][0];
      expect(createArg._id).toBe('rt-session-123');
      expect(createArg.deploymentId).toBe('deploy-456');
    });

    test('sets channelHistory from the initial channel', async () => {
      const doc = makeSessionDoc({ channelHistory: ['voice'] });
      mockSessionCreate.mockResolvedValue(doc);

      const store = makeStore();
      await store.createSession({
        tenantId: 'tenant-unit-001',
        projectId: 'project-001',
        channel: 'voice',
        environment: 'production',
        agentName: 'voice_agent',
        agentVersion: '1.0.0',
      });

      const createArg = mockSessionCreate.mock.calls[0][0];
      expect(createArg.channelHistory).toEqual(['voice']);
    });
  });

  // ── getSession ─────────────────────────────────────────────────────────

  describe('getSession', () => {
    test('returns mapped session when found', async () => {
      const doc = makeSessionDoc();
      mockSessionFindOne.mockReturnValue(chainable(doc));

      const store = makeStore();
      const session = await store.getSession('session-001');

      expect(session).not.toBeNull();
      expect(session!.id).toBe('session-001');
      expect(session!.channel).toBe('web');
      expect(session!.currentAgent).toBe('greeting_agent');
    });

    test('returns null when session does not exist', async () => {
      mockSessionFindOne.mockReturnValue(chainable(null));

      const store = makeStore();
      const session = await store.getSession('nonexistent');

      expect(session).toBeNull();
    });

    test('calls withTenantContext for tenant isolation', async () => {
      mockSessionFindOne.mockReturnValue(chainable(null));

      const store = makeStore();
      await store.getSession('session-001');

      expect(withTenantContext).toHaveBeenCalled();
    });
  });

  // ── updateSession ──────────────────────────────────────────────────────

  describe('updateSession', () => {
    test('updates specified fields and returns updated session', async () => {
      const existingDoc = makeSessionDoc();
      mockSessionFindOne.mockReturnValue(chainable(existingDoc));
      const updatedDoc = makeSessionDoc({
        currentAgent: 'new_agent',
        status: 'idle',
        lastActivityAt: new Date(),
      });
      mockSessionFindOneAndUpdate.mockResolvedValue(updatedDoc);

      const store = makeStore();
      const result = await store.updateSession('session-001', {
        currentAgent: 'new_agent',
        status: 'idle' as any,
      });

      expect(result.currentAgent).toBe('new_agent');
      expect(mockSessionFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'session-001' },
        { $set: expect.objectContaining({ currentAgent: 'new_agent' }) },
        { new: true, lean: true },
      );
    });

    test('throws error when session not found', async () => {
      mockSessionFindOne.mockReturnValue(chainable(null));
      mockSessionFindOneAndUpdate.mockResolvedValue(null);

      const store = makeStore();
      await expect(store.updateSession('nonexistent', { status: 'idle' as any })).rejects.toThrow(
        'Session not found: nonexistent',
      );
    });

    test('always updates lastActivityAt', async () => {
      const existingDoc = makeSessionDoc();
      mockSessionFindOne.mockReturnValue(chainable(existingDoc));
      const updatedDoc = makeSessionDoc();
      mockSessionFindOneAndUpdate.mockResolvedValue(updatedDoc);

      const store = makeStore();
      await store.updateSession('session-001', { context: { step: 'gather' } });

      const setFields = mockSessionFindOneAndUpdate.mock.calls[0][1].$set;
      expect(setFields.lastActivityAt).toBeInstanceOf(Date);
    });

    test('handles all updatable fields', async () => {
      const existingDoc = makeSessionDoc();
      mockSessionFindOne.mockReturnValue(chainable(existingDoc));
      const updatedDoc = makeSessionDoc();
      mockSessionFindOneAndUpdate.mockResolvedValue(updatedDoc);

      const store = makeStore();
      await store.updateSession('session-001', {
        currentAgent: 'agent_b',
        agentVersion: '2.0.0',
        status: 'idle' as any,
        channel: 'voice' as any,
        context: { step: 1 },
        metadata: { key: 'val' },
        environment: 'staging' as any,
        disposition: 'completed' as any,
        dispositionCode: 'SUCCESS',
        contactId: 'contact-123',
        callerNumber: '+15551234567',
        workflowId: 'wf-001',
        workflowStepId: 'step-001',
        endedAt: NOW,
        callDuration: 120,
      });

      const setFields = mockSessionFindOneAndUpdate.mock.calls[0][1].$set;
      expect(setFields.currentAgent).toBe('agent_b');
      expect(setFields.agentVersion).toBe('2.0.0');
      expect(setFields.channel).toBe('voice');
      expect(setFields.context).toEqual({ step: 1 });
      expect(setFields.metadata).toEqual({ key: 'val' });
      expect(setFields.disposition).toBe('completed');
      expect(setFields.dispositionCode).toBe('SUCCESS');
      expect(setFields.contactId).toBe('contact-123');
      expect(setFields.callerNumber).toBe('+15551234567');
      expect(setFields.workflowId).toBe('wf-001');
      expect(setFields.workflowStepId).toBe('step-001');
      expect(setFields.callDuration).toBe(120);
    });

    test('only includes fields that are explicitly provided', async () => {
      const existingDoc = makeSessionDoc();
      mockSessionFindOne.mockReturnValue(chainable(existingDoc));
      const updatedDoc = makeSessionDoc();
      mockSessionFindOneAndUpdate.mockResolvedValue(updatedDoc);

      const store = makeStore();
      await store.updateSession('session-001', { currentAgent: 'new_agent' });

      const setFields = mockSessionFindOneAndUpdate.mock.calls[0][1].$set;
      expect(setFields.currentAgent).toBe('new_agent');
      expect(setFields.channel).toBeUndefined();
      expect(setFields.context).toBeUndefined();
    });
  });

  // ── endSession ─────────────────────────────────────────────────────────

  describe('endSession', () => {
    test('ends session with disposition and sets endedAt', async () => {
      const existingDoc = makeSessionDoc({ messageCount: 3 });
      mockSessionFindOne.mockReturnValue(chainable(existingDoc));

      const endedDoc = makeSessionDoc({
        status: 'ended',
        disposition: 'completed',
        endedAt: NOW,
      });
      mockSessionFindOneAndUpdate.mockResolvedValue(endedDoc);

      const store = makeStore();
      const result = await store.endSession('session-001', 'completed');

      expect(result.status).toBe('ended');
      expect(result.disposition).toBe('completed');
      expect(mockSessionFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'session-001' },
        {
          $set: expect.objectContaining({
            status: 'ended',
            disposition: 'completed',
          }),
        },
        { new: true, lean: true },
      );
    });

    test('deletes ghost sessions with zero messages', async () => {
      const { deleteSession: mockCascadeDelete } = await import('@agent-platform/database/cascade');
      const ghostDoc = makeSessionDoc({ messageCount: 0 });
      mockSessionFindOne.mockReturnValue(chainable(ghostDoc));

      const store = makeStore();
      const result = await store.endSession('session-001', 'abandoned');

      expect(mockCascadeDelete).toHaveBeenCalledWith('session-001');
      expect(result.status).toBe('ended');
      expect(result.disposition).toBe('abandoned');
    });

    test('throws error when session not found for non-ghost end', async () => {
      const existingDoc = makeSessionDoc({ messageCount: 5 });
      mockSessionFindOne.mockReturnValue(chainable(existingDoc));
      mockSessionFindOneAndUpdate.mockResolvedValue(null);

      const store = makeStore();
      await expect(store.endSession('nonexistent', 'completed')).rejects.toThrow(
        'Session not found',
      );
    });
  });

  // ── resumeSession ──────────────────────────────────────────────────────

  describe('resumeSession', () => {
    test('returns null when no matching session exists', async () => {
      mockSessionFindOne.mockReturnValue(chainable(null));

      const store = makeStore();
      const result = await store.resumeSession({
        customerId: 'customer-001',
        channel: 'web',
      });

      expect(result).toBeNull();
    });

    test('returns session when active session found', async () => {
      const doc = makeSessionDoc({ status: 'active' });
      mockSessionFindOne.mockReturnValue(chainable(doc));

      const store = makeStore();
      const result = await store.resumeSession({
        customerId: 'customer-001',
        channel: 'web',
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe('session-001');
    });

    test('reactivates paused sessions', async () => {
      const pausedDoc = makeSessionDoc({ status: 'paused' });
      mockSessionFindOne.mockReturnValue(chainable(pausedDoc));

      const reactivatedDoc = makeSessionDoc({ status: 'active' });
      mockSessionFindOneAndUpdate.mockResolvedValue(reactivatedDoc);

      const store = makeStore();
      const result = await store.resumeSession({
        customerId: 'customer-001',
        channel: 'web',
      });

      expect(result).not.toBeNull();
      expect(result!.status).toBe('active');
      expect(mockSessionFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'session-001' },
        {
          $set: expect.objectContaining({ status: 'active' }),
        },
        { new: true, lean: true },
      );
    });

    test('returns null when reactivation fails', async () => {
      const pausedDoc = makeSessionDoc({ status: 'paused' });
      mockSessionFindOne.mockReturnValue(chainable(pausedDoc));
      mockSessionFindOneAndUpdate.mockResolvedValue(null);

      const store = makeStore();
      const result = await store.resumeSession({
        customerId: 'customer-001',
        channel: 'web',
      });

      expect(result).toBeNull();
    });

    test('builds query with maxAgeMs filter', async () => {
      mockSessionFindOne.mockReturnValue(chainable(null));

      const store = makeStore();
      await store.resumeSession({
        customerId: 'customer-001',
        channel: 'web',
        maxAgeMs: 60_000,
      });

      const queryArg = mockSessionFindOne.mock.calls[0][0];
      expect(queryArg.lastActivityAt).toBeDefined();
      expect(queryArg.lastActivityAt.$gte).toBeInstanceOf(Date);
    });

    test('includes anonymousId in query when provided', async () => {
      mockSessionFindOne.mockReturnValue(chainable(null));

      const store = makeStore();
      await store.resumeSession({
        anonymousId: 'anon-123',
        channel: 'web',
      });

      const queryArg = mockSessionFindOne.mock.calls[0][0];
      expect(queryArg.anonymousId).toBe('anon-123');
    });
  });

  // ── querySessions ──────────────────────────────────────────────────────

  describe('querySessions', () => {
    test('returns sessions and total count', async () => {
      const docs = [makeSessionDoc(), makeSessionDoc({ _id: 'session-002' })];
      const findChain = chainable(docs);
      mockSessionFind.mockReturnValue(findChain);
      mockSessionCountDocuments.mockResolvedValue(2);

      const store = makeStore();
      const result = await store.querySessions({});

      expect(result.sessions).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    test('applies filter criteria', async () => {
      mockSessionFind.mockReturnValue(chainable([]));
      mockSessionCountDocuments.mockResolvedValue(0);

      const store = makeStore();
      await store.querySessions({
        customerId: 'customer-001',
        status: 'active' as any,
        channel: 'web' as any,
        environment: 'production' as any,
      });

      const filterArg = mockSessionFind.mock.calls[0][0];
      expect(filterArg.customerId).toBe('customer-001');
      expect(filterArg.status).toBe('active');
      expect(filterArg.channel).toBe('web');
      expect(filterArg.environment).toBe('production');
    });

    test('applies date range filters', async () => {
      mockSessionFind.mockReturnValue(chainable([]));
      mockSessionCountDocuments.mockResolvedValue(0);

      const startDate = new Date('2026-01-01');
      const endDate = new Date('2026-01-31');

      const store = makeStore();
      await store.querySessions({ startDate, endDate });

      const filterArg = mockSessionFind.mock.calls[0][0];
      expect(filterArg.startedAt.$gte).toBe(startDate);
      expect(filterArg.startedAt.$lte).toBe(endDate);
    });

    test('uses default limit of 50 and offset of 0', async () => {
      const findChain = chainable([]);
      mockSessionFind.mockReturnValue(findChain);
      mockSessionCountDocuments.mockResolvedValue(0);

      const store = makeStore();
      await store.querySessions({});

      expect(findChain.skip).toHaveBeenCalledWith(0);
      expect(findChain.limit).toHaveBeenCalledWith(50);
    });

    test('uses custom limit and offset', async () => {
      const findChain = chainable([]);
      mockSessionFind.mockReturnValue(findChain);
      mockSessionCountDocuments.mockResolvedValue(0);

      const store = makeStore();
      await store.querySessions({ limit: 10, offset: 20 });

      expect(findChain.skip).toHaveBeenCalledWith(20);
      expect(findChain.limit).toHaveBeenCalledWith(10);
    });
  });

  // ── recordVoiceMetadata ────────────────────────────────────────────────

  describe('recordVoiceMetadata', () => {
    test('updates voice metadata on the session', async () => {
      mockSessionFindOneAndUpdate.mockResolvedValue(undefined);

      const store = makeStore();
      await store.recordVoiceMetadata('session-001', {
        provider: 'twilio',
        callSid: 'CA123',
      } as any);

      expect(mockSessionFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'session-001' },
        {
          $set: expect.objectContaining({
            'metadata.voice': expect.objectContaining({ provider: 'twilio' }),
          }),
        },
      );
    });
  });

  // ── captureAbandonedCall ───────────────────────────────────────────────

  describe('captureAbandonedCall', () => {
    test('marks session as abandoned with reason and transcript', async () => {
      mockSessionFindOneAndUpdate.mockResolvedValue(undefined);

      const store = makeStore();
      await store.captureAbandonedCall('session-001', 'last words spoken', 'caller_hangup');

      expect(mockSessionFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'session-001' },
        {
          $set: expect.objectContaining({
            status: 'ended',
            disposition: 'abandoned',
            'metadata.abandonReason': 'caller_hangup',
            'metadata.lastTranscript': 'last words spoken',
          }),
        },
      );
    });
  });

  // ── linkContact ────────────────────────────────────────────────────────

  describe('linkContact', () => {
    test('sets contactId on the session', async () => {
      mockSessionFindOneAndUpdate.mockResolvedValue(undefined);

      const store = makeStore();
      await store.linkContact('session-001', 'contact-456');

      expect(mockSessionFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'session-001' },
        {
          $set: expect.objectContaining({
            contactId: 'contact-456',
          }),
        },
      );
    });
  });

  // ── associateWorkflow ──────────────────────────────────────────────────

  describe('associateWorkflow', () => {
    test('sets workflowId on the session', async () => {
      mockSessionFindOneAndUpdate.mockResolvedValue(undefined);

      const store = makeStore();
      await store.associateWorkflow('session-001', 'wf-001');

      const setFields = mockSessionFindOneAndUpdate.mock.calls[0][1].$set;
      expect(setFields.workflowId).toBe('wf-001');
    });

    test('includes stepId when provided', async () => {
      mockSessionFindOneAndUpdate.mockResolvedValue(undefined);

      const store = makeStore();
      await store.associateWorkflow('session-001', 'wf-001', 'step-003');

      const setFields = mockSessionFindOneAndUpdate.mock.calls[0][1].$set;
      expect(setFields.workflowId).toBe('wf-001');
      expect(setFields.workflowStepId).toBe('step-003');
    });

    test('does not set workflowStepId when stepId is not provided', async () => {
      mockSessionFindOneAndUpdate.mockResolvedValue(undefined);

      const store = makeStore();
      await store.associateWorkflow('session-001', 'wf-001');

      const setFields = mockSessionFindOneAndUpdate.mock.calls[0][1].$set;
      expect(setFields.workflowStepId).toBeUndefined();
    });
  });

  // ── cleanup ────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    test('deletes ended sessions older than cutoff', async () => {
      mockSessionDeleteMany.mockResolvedValue({ deletedCount: 5 });

      const store = makeStore();
      const deleted = await store.cleanup(86_400_000); // 24 hours

      expect(deleted).toBe(5);
      expect(mockSessionDeleteMany).toHaveBeenCalledWith({
        status: 'ended',
        endedAt: { $lt: expect.any(Date) },
      });
    });

    test('returns 0 when no sessions match', async () => {
      mockSessionDeleteMany.mockResolvedValue({ deletedCount: 0 });

      const store = makeStore();
      const deleted = await store.cleanup(1000);

      expect(deleted).toBe(0);
    });

    test('handles undefined deletedCount gracefully', async () => {
      mockSessionDeleteMany.mockResolvedValue({});

      const store = makeStore();
      const deleted = await store.cleanup(1000);

      expect(deleted).toBe(0);
    });
  });

  // ── Tenant isolation ──────────────────────────────────────────────────

  describe('tenant isolation', () => {
    test('withTenant calls withTenantContext when tenantId is available', async () => {
      mockSessionFindOne.mockReturnValue(chainable(null));

      const store = makeStore();
      await store.getSession('session-001');

      expect(getCurrentTenantId).toHaveBeenCalled();
      expect(withTenantContext).toHaveBeenCalledWith(
        { tenantId: 'tenant-unit-001' },
        expect.any(Function),
      );
    });

    test('withTenant throws when no tenantId in ALS', async () => {
      vi.mocked(getCurrentTenantId).mockReturnValueOnce(undefined as any);

      const store = makeStore();
      // withTenant is now fail-closed — it throws when tenant context is missing
      await expect(store.getSession('session-001')).rejects.toThrow('Tenant context required');
    });
  });

  // ── mapDocToSession ────────────────────────────────────────────────────

  describe('mapDocToSession', () => {
    test('maps _id to id', async () => {
      const doc = makeSessionDoc({ _id: 'custom-id-999' });
      mockSessionFindOne.mockReturnValue(chainable(doc));

      const store = makeStore();
      const session = await store.getSession('custom-id-999');

      expect(session!.id).toBe('custom-id-999');
    });

    test('defaults context to empty object when null', async () => {
      const doc = makeSessionDoc({ context: null });
      mockSessionFindOne.mockReturnValue(chainable(doc));

      const store = makeStore();
      const session = await store.getSession('session-001');

      expect(session!.context).toEqual({});
    });

    test('defaults metadata to empty object when null', async () => {
      const doc = makeSessionDoc({ metadata: null });
      mockSessionFindOne.mockReturnValue(chainable(doc));

      const store = makeStore();
      const session = await store.getSession('session-001');

      expect(session!.metadata).toEqual({});
    });

    test('defaults channelHistory to empty array when null', async () => {
      const doc = makeSessionDoc({ channelHistory: null });
      mockSessionFindOne.mockReturnValue(chainable(doc));

      const store = makeStore();
      const session = await store.getSession('session-001');

      expect(session!.channelHistory).toEqual([]);
    });
  });

  // ── Factory function ───────────────────────────────────────────────────

  describe('createMongoConversationStore', () => {
    test('returns a MongoConversationStore instance', () => {
      const store = createMongoConversationStore();
      expect(store).toBeInstanceOf(MongoConversationStore);
    });

    test('merges provided config', () => {
      const store = createMongoConversationStore({
        sessionTtlMs: 3600_000,
      });
      expect(store).toBeInstanceOf(MongoConversationStore);
    });
  });
});

// ---------------------------------------------------------------------------
// MongoMessageStore
// ---------------------------------------------------------------------------

describe('MongoMessageStore', () => {
  function makeStore() {
    return new MongoMessageStore({ type: 'mongodb' });
  }

  // ── addMessage ─────────────────────────────────────────────────────────

  describe('addMessage', () => {
    test('creates a message and looks up tenantId from session', async () => {
      // Session lookup for tenantId
      mockSessionFindOne.mockReturnValue(
        chainable({ tenantId: 'tenant-unit-001', projectId: 'project-001' }),
      );

      const doc = makeMessageDoc();
      mockMessageCreate.mockResolvedValue(doc);

      // Non-blocking session update — provide a mock that returns a thenable with .catch
      mockSessionFindOneAndUpdate.mockReturnValue({
        catch: vi.fn(),
      });

      const store = makeStore();
      const message = await store.addMessage({
        sessionId: 'session-001',
        role: 'user',
        content: 'Hello!',
        channel: 'web',
        traceId: 'trace-001',
      });

      expect(message).toBeDefined();
      expect(message.id).toBe('msg-001');
      expect(message.sessionId).toBe('session-001');
      expect(message.role).toBe('user');
      expect(message.content).toBe('Hello!');
      expect(message.channel).toBe('web');
      expect(message.traceId).toBe('trace-001');
      expect(mockMessageCreate).toHaveBeenCalledTimes(1);
      expect(mockMessageCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-unit-001',
          projectId: 'project-001',
        }),
      );
    });

    test('always sets encrypted flag to true (encryption handled by Mongoose plugin)', async () => {
      mockSessionFindOne.mockReturnValue(
        chainable({ tenantId: 'tenant-unit-001', projectId: 'project-001' }),
      );
      mockMessageCreate.mockResolvedValue(makeMessageDoc());
      mockSessionFindOneAndUpdate.mockReturnValue({ catch: vi.fn() });

      const store = makeStore();
      await store.addMessage({
        sessionId: 'session-001',
        role: 'user',
        content: 'Plaintext message',
        channel: 'web',
        traceId: 'trace-001',
      });

      const createArg = mockMessageCreate.mock.calls[0][0];
      expect(createArg.encrypted).toBe(true);
    });

    test('rejects message when session lookup returns null (fail-closed)', async () => {
      mockSessionFindOne.mockReturnValue(chainable(null));

      const store = makeStore();
      await expect(
        store.addMessage({
          sessionId: 'session-001',
          role: 'user',
          content: 'Orphan message',
          channel: 'web',
          traceId: 'trace-001',
        }),
      ).rejects.toThrow('missing tenantId or projectId');

      expect(mockMessageCreate).not.toHaveBeenCalled();
    });

    test('falls back to caller-provided tenantId and projectId when session is not materialized yet', async () => {
      mockSessionFindOne.mockReturnValue(chainable(null));
      mockMessageCreate.mockResolvedValue(makeMessageDoc());
      mockSessionFindOneAndUpdate.mockReturnValue({ catch: vi.fn() });

      const store = makeStore();
      await store.addMessage({
        sessionId: 'session-001',
        role: 'user',
        content: 'Scoped fallback message',
        channel: 'web',
        traceId: 'trace-001',
        tenantId: 'tenant-fallback-001',
        projectId: 'project-fallback-001',
      });

      expect(mockMessageCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-001',
          tenantId: 'tenant-fallback-001',
          projectId: 'project-fallback-001',
        }),
      );
      expect(mockSessionFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'session-001', tenantId: 'tenant-fallback-001' },
        {
          $set: { lastActivityAt: expect.any(Date) },
          $inc: { messageCount: 1 },
        },
      );
    });

    test('uses caller-provided projectId when session lookup is missing only project scope', async () => {
      mockSessionFindOne.mockReturnValue(chainable({ tenantId: 'tenant-unit-001', projectId: '' }));
      mockMessageCreate.mockResolvedValue(makeMessageDoc());
      mockSessionFindOneAndUpdate.mockReturnValue({ catch: vi.fn() });

      const store = makeStore();
      await store.addMessage({
        sessionId: 'session-001',
        role: 'assistant',
        content: 'Scoped project fallback',
        channel: 'web',
        traceId: 'trace-001',
        tenantId: 'tenant-unit-001',
        projectId: 'project-fallback-001',
      });

      expect(mockMessageCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-001',
          tenantId: 'tenant-unit-001',
          projectId: 'project-fallback-001',
        }),
      );
    });

    test('sets expiresAt based on tenant messageRetentionDays (resolved from config)', async () => {
      mockSessionFindOne.mockReturnValue(
        chainable({ tenantId: 'tenant-001', projectId: 'project-001' }),
      );
      mockMessageCreate.mockResolvedValue(makeMessageDoc());
      mockSessionFindOneAndUpdate.mockReturnValue({ catch: vi.fn() });

      const store = makeStore();
      const before = Date.now();
      await store.addMessage({
        sessionId: 'session-001',
        role: 'user',
        content: 'Expiring message',
        channel: 'web',
        traceId: 'trace-001',
      });

      const createArg = mockMessageCreate.mock.calls[0][0];
      const expiresAt = createArg.expiresAt as Date;
      // Retention comes from tenant config (FREE default = 30 days) or fallback (90 days)
      // Either way, expiresAt should be at least 30 days from now
      const expectedMin30d = before + 30 * 24 * 60 * 60 * 1000;
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin30d - 1000);
      // And no more than 90 days (the fallback maximum)
      const expectedMax90d = before + 90 * 24 * 60 * 60 * 1000;
      expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax90d + 1000);
    });

    test('passes metadata through to MessageModel.create', async () => {
      mockSessionFindOne.mockReturnValue(
        chainable({ tenantId: 'tenant-001', projectId: 'project-001' }),
      );
      mockMessageCreate.mockResolvedValue(makeMessageDoc({ metadata: { tool: 'search' } }));
      mockSessionFindOneAndUpdate.mockReturnValue({ catch: vi.fn() });

      const store = makeStore();
      await store.addMessage({
        sessionId: 'session-001',
        role: 'tool',
        content: 'tool result',
        channel: 'web',
        traceId: 'trace-001',
        metadata: { tool: 'search' },
      });

      const createArg = mockMessageCreate.mock.calls[0][0];
      expect(createArg.metadata).toEqual({ tool: 'search' });
    });

    test('increments messageCount on session (non-blocking)', async () => {
      mockSessionFindOne.mockReturnValue(
        chainable({ tenantId: 'tenant-001', projectId: 'project-001' }),
      );
      mockMessageCreate.mockResolvedValue(makeMessageDoc());
      const catchFn = vi.fn();
      mockSessionFindOneAndUpdate.mockReturnValue({ catch: catchFn });

      const store = makeStore();
      await store.addMessage({
        sessionId: 'session-001',
        role: 'user',
        content: 'Hello',
        channel: 'web',
        traceId: 'trace-001',
      });

      expect(mockSessionFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'session-001', tenantId: 'tenant-001' },
        {
          $set: { lastActivityAt: expect.any(Date) },
          $inc: { messageCount: 1 },
        },
      );
    });

    test('rejects message when tenantId is empty (fail-closed)', async () => {
      mockSessionFindOne.mockReturnValue(chainable({ tenantId: '' }));

      const encService = {
        encryptForTenant: vi.fn().mockReturnValue('encrypted'),
        decryptForTenant: vi.fn(),
      };

      const store = makeStore(encService);
      await expect(
        store.addMessage({
          sessionId: 'session-001',
          role: 'user',
          content: 'No encryption',
          channel: 'web',
          traceId: 'trace-001',
        }),
      ).rejects.toThrow('missing tenantId or projectId');

      expect(encService.encryptForTenant).not.toHaveBeenCalled();
      expect(mockMessageCreate).not.toHaveBeenCalled();
    });
  });

  // ── getMessages ────────────────────────────────────────────────────────

  describe('getMessages', () => {
    test('returns mapped messages for a session', async () => {
      const docs = [
        makeMessageDoc({ _id: 'msg-001', role: 'user', content: 'Hello' }),
        makeMessageDoc({ _id: 'msg-002', role: 'assistant', content: 'Hi!' }),
      ];
      mockMessageFind.mockReturnValue(chainable(docs));

      const store = makeStore();
      const messages = await store.getMessages({
        sessionId: 'session-001',
        tenantId: 'tenant-unit-001',
      });

      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe('msg-001');
      expect(messages[1].role).toBe('assistant');
    });

    test('excludes system messages by default', async () => {
      mockMessageFind.mockReturnValue(chainable([]));

      const store = makeStore();
      await store.getMessages({ sessionId: 'session-001', tenantId: 'tenant-unit-001' });

      const filterArg = mockMessageFind.mock.calls[0][0];
      expect(filterArg.role).toEqual({ $ne: 'system' });
    });

    test('includes system messages when includeSystem is true', async () => {
      mockMessageFind.mockReturnValue(chainable([]));

      const store = makeStore();
      await store.getMessages({
        sessionId: 'session-001',
        tenantId: 'tenant-unit-001',
        includeSystem: true,
      });

      const filterArg = mockMessageFind.mock.calls[0][0];
      expect(filterArg.role).toBeUndefined();
    });

    test('filters by specified roles', async () => {
      mockMessageFind.mockReturnValue(chainable([]));

      const store = makeStore();
      await store.getMessages({
        sessionId: 'session-001',
        tenantId: 'tenant-unit-001',
        roles: ['user', 'assistant'],
        includeSystem: true,
      });

      const filterArg = mockMessageFind.mock.calls[0][0];
      expect(filterArg.role).toEqual({ $in: ['user', 'assistant'] });
    });

    test('filters system from role list when includeSystem is false', async () => {
      mockMessageFind.mockReturnValue(chainable([]));

      const store = makeStore();
      await store.getMessages({
        sessionId: 'session-001',
        tenantId: 'tenant-unit-001',
        roles: ['user', 'system'],
        includeSystem: false,
      });

      const filterArg = mockMessageFind.mock.calls[0][0];
      expect(filterArg.role).toEqual({ $in: ['user'] });
    });

    test('uses default limit of 100 and offset of 0', async () => {
      const findChain = chainable([]);
      mockMessageFind.mockReturnValue(findChain);

      const store = makeStore();
      await store.getMessages({ sessionId: 'session-001', tenantId: 'tenant-unit-001' });

      expect(findChain.skip).toHaveBeenCalledWith(0);
      expect(findChain.limit).toHaveBeenCalledWith(100);
    });

    test('uses custom limit and offset', async () => {
      const findChain = chainable([]);
      mockMessageFind.mockReturnValue(findChain);

      const store = makeStore();
      await store.getMessages({
        sessionId: 'session-001',
        tenantId: 'tenant-unit-001',
        limit: 25,
        offset: 10,
      });

      expect(findChain.skip).toHaveBeenCalledWith(10);
      expect(findChain.limit).toHaveBeenCalledWith(25);
    });

    test('sorts messages by timestamp ascending', async () => {
      const findChain = chainable([]);
      mockMessageFind.mockReturnValue(findChain);

      const store = makeStore();
      await store.getMessages({ sessionId: 'session-001', tenantId: 'tenant-unit-001' });

      expect(findChain.sort).toHaveBeenCalledWith({ timestamp: 1 });
    });

    test('returns content as-is (decryption handled by Mongoose plugin)', async () => {
      const docs = [
        makeMessageDoc({
          content: 'Hello!',
          encrypted: true,
          tenantId: 'tenant-unit-001',
        }),
      ];
      mockMessageFind.mockReturnValue(chainable(docs));

      const store = makeStore();
      const messages = await store.getMessages({
        sessionId: 'session-001',
        tenantId: 'tenant-unit-001',
      });

      expect(messages[0].content).toBe('Hello!');
    });

    test('returns content directly (decryption handled by Mongoose plugin, not store)', async () => {
      const docs = [
        makeMessageDoc({
          content: 'plaintext-after-plugin-decrypt',
          encrypted: true,
          tenantId: 'tenant-unit-001',
        }),
      ];
      mockMessageFind.mockReturnValue(chainable(docs));

      const store = makeStore();
      const messages = await store.getMessages({
        sessionId: 'session-001',
        tenantId: 'tenant-unit-001',
      });

      expect(messages[0].content).toBe('plaintext-after-plugin-decrypt');
    });
  });

  // ── getMessageCount ────────────────────────────────────────────────────

  describe('getMessageCount', () => {
    test('returns count from countDocuments', async () => {
      mockMessageCountDocuments.mockResolvedValue(42);

      const store = makeStore();
      const count = await store.getMessageCount('session-001');

      expect(count).toBe(42);
      expect(mockMessageCountDocuments).toHaveBeenCalledWith({ sessionId: 'session-001' });
    });

    test('returns 0 for empty session', async () => {
      mockMessageCountDocuments.mockResolvedValue(0);

      const store = makeStore();
      const count = await store.getMessageCount('empty-session');

      expect(count).toBe(0);
    });
  });

  // ── deleteBySession ────────────────────────────────────────────────────

  describe('deleteBySession', () => {
    test('deletes all messages for a session and returns count', async () => {
      mockMessageDeleteMany.mockResolvedValue({ deletedCount: 15 });

      const store = makeStore();
      const deleted = await store.deleteBySession('session-001');

      expect(deleted).toBe(15);
      expect(mockMessageDeleteMany).toHaveBeenCalledWith({ sessionId: 'session-001' });
    });

    test('returns 0 when no messages exist', async () => {
      mockMessageDeleteMany.mockResolvedValue({ deletedCount: 0 });

      const store = makeStore();
      const deleted = await store.deleteBySession('empty-session');

      expect(deleted).toBe(0);
    });

    test('handles undefined deletedCount', async () => {
      mockMessageDeleteMany.mockResolvedValue({});

      const store = makeStore();
      const deleted = await store.deleteBySession('session-001');

      expect(deleted).toBe(0);
    });
  });

  // ── cleanup ────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    test('deletes messages older than cutoff', async () => {
      mockMessageDeleteMany.mockResolvedValue({ deletedCount: 100 });

      const store = makeStore();
      const deleted = await store.cleanup(86_400_000);

      expect(deleted).toBe(100);
      expect(mockMessageDeleteMany).toHaveBeenCalledWith({
        timestamp: { $lt: expect.any(Date) },
      });
    });

    test('returns 0 when nothing to clean', async () => {
      mockMessageDeleteMany.mockResolvedValue({ deletedCount: 0 });

      const store = makeStore();
      const deleted = await store.cleanup(1000);

      expect(deleted).toBe(0);
    });
  });

  // ── mapDocToMessage ────────────────────────────────────────────────────

  describe('mapDocToMessage', () => {
    test('maps _id to id', async () => {
      mockMessageFind.mockReturnValue(chainable([makeMessageDoc({ _id: 'unique-msg-id' })]));

      const store = makeStore();
      const messages = await store.getMessages({
        sessionId: 'session-001',
        tenantId: 'tenant-unit-001',
      });

      expect(messages[0].id).toBe('unique-msg-id');
    });

    test('defaults metadata to empty object when null', async () => {
      mockMessageFind.mockReturnValue(chainable([makeMessageDoc({ metadata: null })]));

      const store = makeStore();
      const messages = await store.getMessages({
        sessionId: 'session-001',
        tenantId: 'tenant-unit-001',
      });

      expect(messages[0].metadata).toEqual({});
    });
  });

  // ── Factory function ───────────────────────────────────────────────────

  describe('createMongoMessageStore', () => {
    test('returns a MongoMessageStore instance', () => {
      const store = createMongoMessageStore();
      expect(store).toBeInstanceOf(MongoMessageStore);
    });

    test('merges provided config', () => {
      const store = createMongoMessageStore({
        messageTtlMs: 7_776_000_000,
      });
      expect(store).toBeInstanceOf(MongoMessageStore);
    });
  });
});
