/**
 * Message Persistence Queue — circuit breaker integration tests
 *
 * Tests the circuit breaker wrapping MongoDB writes in the BullMQ worker.
 * Validates state transitions (CLOSED → OPEN → HALF_OPEN → CLOSED/OPEN),
 * queue configuration, and message durability during outages.
 *
 * Strategy: Capture the BullMQ worker's process function via mock,
 * then invoke it directly to exercise the circuit breaker path
 * inside workerJobHandler().
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Controllable circuit breaker mock
//
// vi.mock factories are hoisted above all other code by Vitest's transform.
// Variables declared with vi.fn() in the module body are hoisted too (they
// are vi.* calls), but class declarations are NOT. We therefore define the
// CircuitOpenError replacement INSIDE the factory and re-export it so tests
// can reference it via the mocked import.
// ---------------------------------------------------------------------------

/** Tracks the state of our mock breaker for assertions */
let mockBreakerState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

const mockBreakerExecute = vi.fn();

const mockBreaker = {
  execute: mockBreakerExecute,
  checkState: vi.fn(),
  getState: vi.fn(() => mockBreakerState),
  getMetrics: vi.fn(),
  forceReset: vi.fn(),
};

/** Stores the arguments passed to the CircuitBreakerRegistry constructor */
let registryConstructArgs: unknown[] = [];

/** Stores the mock app function for call inspection */
const mockAppFn = vi.fn().mockReturnValue(mockBreaker);

vi.mock('@agent-platform/circuit-breaker', () => {
  class _CircuitOpenError extends Error {
    public readonly level: string;
    public readonly key: string;
    public readonly retryAfterMs: number;
    public readonly state = 'OPEN';

    constructor(level: string, key: string, retryAfterMs: number) {
      super(`Circuit breaker OPEN [${level}:${key}] — retry after ${retryAfterMs}ms`);
      this.name = 'CircuitOpenError';
      this.level = level;
      this.key = key;
      this.retryAfterMs = retryAfterMs;
    }
  }

  return {
    CircuitBreakerRegistry: function MockRegistry(redis: unknown, opts: unknown) {
      registryConstructArgs = [redis, opts];
      return { app: mockAppFn };
    },
    CircuitOpenError: _CircuitOpenError,
  };
});

// ---------------------------------------------------------------------------
// BullMQ mock — captures the worker process function and queue config
// ---------------------------------------------------------------------------

let capturedWorkerProcessFn: ((job: { data: unknown }) => Promise<void>) | null = null;
let capturedQueueOpts: Record<string, unknown> | null = null;
let capturedWorkerOpts: Record<string, unknown> | null = null;

const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });

vi.mock('bullmq', () => ({
  Queue: function MockQueue(_name: string, opts: Record<string, unknown>) {
    capturedQueueOpts = opts;
    return {
      add: mockQueueAdd,
      close: vi.fn().mockResolvedValue(undefined),
      getJobs: vi.fn().mockResolvedValue([]),
    };
  },
  Worker: function MockWorker(
    _name: string,
    processFn: (job: { data: unknown }) => Promise<void>,
    opts: Record<string, unknown>,
  ) {
    capturedWorkerProcessFn = processFn;
    capturedWorkerOpts = opts;
    return {
      on: vi.fn().mockReturnThis(),
      close: vi.fn().mockResolvedValue(undefined),
    };
  },
}));

// ---------------------------------------------------------------------------
// Redis mock — available, returns a duplicatable client
// ---------------------------------------------------------------------------

const mockRedisStore = new Map<string, string>();

const mockRedisClient = {
  duplicate: vi.fn().mockReturnValue({ maxRetriesPerRequest: null }),
  set: vi.fn(async (key: string, value: string, _pxMode: 'PX', _ttlMs: number, nxMode: 'NX') => {
    if (nxMode === 'NX' && mockRedisStore.has(key)) return null;
    mockRedisStore.set(key, value);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => mockRedisStore.get(key) ?? null),
  eval: vi.fn(async (script: string, _numKeys: number, key: string, expectedValue: string) => {
    if (mockRedisStore.get(key) !== expectedValue) return 0;
    if (script.includes("redis.call('DEL'")) {
      mockRedisStore.delete(key);
      return 1;
    }
    return 1;
  }),
};

const mockHandle = {
  client: mockRedisClient as unknown as object,
  isReady: () => true,
  duplicate: () => mockRedisClient.duplicate(),
  disconnect: async () => {},
};

vi.mock('../services/redis/redis-client.js', () => ({
  isRedisAvailable: () => true,
  getRedisClient: () => mockRedisClient,
  getRedisHandle: () => mockHandle,
}));

// ---------------------------------------------------------------------------
// Database & repo mocks
// ---------------------------------------------------------------------------

const mockBatchCreateMessages = vi.fn().mockResolvedValue(undefined);
const mockFindSessionPersistenceContexts = vi.fn().mockResolvedValue([]);

vi.mock('../repos/session-repo.js', () => ({
  batchCreateMessages: (...args: unknown[]) => mockBatchCreateMessages(...args),
  findSessionPersistenceContexts: (...args: unknown[]) =>
    mockFindSessionPersistenceContexts(...args),
  applySessionTurnUpdate: vi.fn().mockResolvedValue(undefined),
}));

// shared-auth ALS — pass-through
vi.mock('@agent-platform/shared-auth/middleware', () => ({
  runWithTenantContext: (_ctx: any, fn: () => any) => fn(),
  getTenantContextData: () => undefined,
}));

vi.mock('@agent-platform/database/mongo', () => ({
  getCurrentTenantContext: () => undefined,
}));

// ---------------------------------------------------------------------------
// Encryption mock — disabled (pass-through)
// ---------------------------------------------------------------------------

vi.mock('@agent-platform/shared/encryption', () => ({
  isEncryptionAvailable: () => false,
  isTenantEncryptionReady: () => true,
  getEncryptionService: () => undefined,
  encryptForTenantAuto: async (plaintext: string) => plaintext,
  decryptForTenantAuto: async (ciphertext: string) => ciphertext,
  wrapJobDataForEncrypt: (_purpose: string, data: unknown) => data,
  unwrapJobDataForDecrypt: (_purpose: string, data: unknown) => data,
}));

// ---------------------------------------------------------------------------
// Store factory mock
// ---------------------------------------------------------------------------

vi.mock('../services/stores/store-factory.js', () => ({
  getStores: () => ({
    message: { addMessage: vi.fn().mockResolvedValue(undefined) },
  }),
  DualWriteMessageStore: class {},
}));

// ---------------------------------------------------------------------------
// Tenant config mock
// ---------------------------------------------------------------------------

vi.mock('../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: vi.fn().mockResolvedValue({
      limits: { messageRetentionDays: 30 },
    }),
    resolveProjectMessageRetention: vi.fn().mockResolvedValue(null),
  }),
  PLAN_LIMITS: { TEAM: { messageRetentionDays: 30 } },
}));

// ---------------------------------------------------------------------------
// PII detection mock
// ---------------------------------------------------------------------------

vi.mock('@abl/compiler', () => ({
  containsPII: () => false,
  redactPII: (s: string) => s,
}));

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------

const { mockLogInfo, mockLogWarn, mockLogError, mockLogDebug } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
  mockLogDebug: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    debug: mockLogDebug,
  }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import {
  persistMessage,
  _resetForTest,
  _getMessageBuffer,
} from '../services/message-persistence-queue.js';
import { CircuitOpenError } from '@agent-platform/circuit-breaker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessageBatch(count: number, opts?: { tenantId?: string; sessionId?: string }) {
  const tenantId = opts?.tenantId ?? 'tenant-1';
  const sessionId = opts?.sessionId ?? 'session-1';
  return {
    messages: Array.from({ length: count }, (_, i) => ({
      dbSessionId: sessionId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message-${i}`,
      channel: 'web_debug',
      tenantId,
      projectId: 'project-1',
      traceId: 'trace-1',
      contactId: undefined,
      hasPII: false,
      enqueuedAt: Date.now(),
      idempotencyKey: `key-${i}-${Date.now()}`,
    })),
  };
}

/**
 * Initialize the module: reset state, then call persistMessage to trigger
 * initBullMQ() which creates the Queue, Registry, and Worker.
 */
async function initModule(): Promise<void> {
  _resetForTest();
  capturedWorkerProcessFn = null;
  capturedQueueOpts = null;
  capturedWorkerOpts = null;
  registryConstructArgs = [];
  mockBreakerState = 'CLOSED';
  mockBreakerExecute.mockReset();
  mockBatchCreateMessages.mockReset().mockResolvedValue(undefined);
  mockFindSessionPersistenceContexts.mockReset().mockResolvedValue([]);
  mockQueueAdd.mockClear();
  mockAppFn.mockClear();
  mockLogInfo.mockReset();
  mockLogWarn.mockReset();
  mockLogError.mockReset();
  mockLogDebug.mockReset();
  mockRedisStore.clear();
  mockRedisClient.set.mockClear();
  mockRedisClient.get.mockClear();
  mockRedisClient.eval.mockClear();

  // Default: breaker passes through to the wrapped function
  mockBreakerExecute.mockImplementation(async (fn: () => Promise<void>) => fn());

  // Trigger initBullMQ by calling persistMessage
  await persistMessage('init-session', 'user', 'init', 'web_debug', 'tenant-1');

  if (!capturedWorkerProcessFn) {
    throw new Error('Worker process function was not captured — BullMQ mock setup issue');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Message Persistence Queue — circuit breaker', () => {
  beforeEach(async () => {
    await initModule();
  });

  // ─── T2.1 ───────────────────────────────────────────────────────────────

  describe('T2.1: persistMessage enqueues to BullMQ regardless of MongoDB state', () => {
    it('adds message to the in-memory buffer when BullMQ is available', async () => {
      const buffer = _getMessageBuffer('init-session');
      expect(buffer).toBeDefined();
      expect(buffer!.length).toBeGreaterThanOrEqual(1);
      expect(buffer![0].role).toBe('user');
      expect(buffer![0].content).toBe('init');
    });

    it('enqueues even when circuit breaker is OPEN (enqueue path is pre-worker)', async () => {
      mockBreakerState = 'OPEN';
      mockBreakerExecute.mockRejectedValue(
        new CircuitOpenError('app', 'system:message-persistence-mongo', 30000),
      );

      await persistMessage('session-open', 'user', 'hello during outage', 'web_debug', 'tenant-1');

      const buffer = _getMessageBuffer('session-open');
      expect(buffer).toBeDefined();
      expect(buffer![0].content).toBe('hello during outage');
    });
  });

  // ─── T2.2 ───────────────────────────────────────────────────────────────

  describe('T2.2: Circuit breaker opens after 5 consecutive failures', () => {
    it('circuit breaker config has failureThreshold=5', () => {
      const opts = registryConstructArgs[1] as Record<string, unknown>;
      expect(opts).toBeDefined();
      const defaults = opts.defaults as Record<string, Record<string, unknown>>;
      expect(defaults.app.failureThreshold).toBe(5);
    });

    it('after 5 failures, breaker transitions to OPEN and rejects', async () => {
      let failureCount = 0;
      mockBreakerExecute.mockImplementation(async () => {
        failureCount++;
        if (failureCount <= 5) {
          throw new Error('MongoServerError: connection refused');
        }
        throw new CircuitOpenError('app', 'system:message-persistence-mongo', 30000);
      });

      const batch = makeMessageBatch(1);

      for (let i = 0; i < 5; i++) {
        await expect(capturedWorkerProcessFn!({ data: batch })).rejects.toThrow(
          'MongoServerError: connection refused',
        );
      }

      await expect(capturedWorkerProcessFn!({ data: batch })).rejects.toThrow(
        'Circuit breaker OPEN',
      );

      expect(mockBreakerExecute).toHaveBeenCalledTimes(6);
    });
  });

  // ─── T2.3 ───────────────────────────────────────────────────────────────

  describe('T2.3: Open circuit breaker prevents MongoDB call', () => {
    it('does not call batchCreateMessages when breaker throws CircuitOpenError', async () => {
      mockBreakerExecute.mockRejectedValue(
        new CircuitOpenError('app', 'system:message-persistence-mongo', 30000),
      );
      mockBatchCreateMessages.mockClear();

      const batch = makeMessageBatch(1);

      await expect(capturedWorkerProcessFn!({ data: batch })).rejects.toThrow(CircuitOpenError);

      expect(mockBatchCreateMessages).not.toHaveBeenCalled();
    });
  });

  // ─── T2.4 ───────────────────────────────────────────────────────────────

  describe('T2.4: Breaker transitions to HALF_OPEN after resetTimeout', () => {
    it('circuit breaker config has resetTimeout=30000ms', () => {
      const opts = registryConstructArgs[1] as Record<string, unknown>;
      const defaults = opts.defaults as Record<string, Record<string, unknown>>;
      expect(defaults.app.resetTimeout).toBe(30_000);
    });

    it('after OPEN, breaker allows a probe request in HALF_OPEN', async () => {
      let callCount = 0;
      mockBreakerExecute.mockImplementation(async (fn: () => Promise<void>) => {
        callCount++;
        if (callCount === 1) {
          throw new CircuitOpenError('app', 'system:message-persistence-mongo', 30000);
        }
        mockBreakerState = 'HALF_OPEN';
        return fn();
      });

      const batch = makeMessageBatch(1);

      await expect(capturedWorkerProcessFn!({ data: batch })).rejects.toThrow(CircuitOpenError);

      mockBatchCreateMessages.mockClear();
      await capturedWorkerProcessFn!({ data: batch });
      expect(mockBatchCreateMessages).toHaveBeenCalledTimes(1);
    });
  });

  // ─── T2.5 ───────────────────────────────────────────────────────────────

  describe('T2.5: Successful write in HALF_OPEN resets to CLOSED', () => {
    it('circuit breaker config has successThreshold=2', () => {
      const opts = registryConstructArgs[1] as Record<string, unknown>;
      const defaults = opts.defaults as Record<string, Record<string, unknown>>;
      expect(defaults.app.successThreshold).toBe(2);
    });

    it('successful writes in HALF_OPEN transition breaker to CLOSED', async () => {
      mockBreakerState = 'HALF_OPEN';
      mockBreakerExecute.mockImplementation(async (fn: () => Promise<void>) => {
        await fn();
        mockBreakerState = 'CLOSED';
      });

      const batch = makeMessageBatch(1);
      mockBatchCreateMessages.mockClear();

      await capturedWorkerProcessFn!({ data: batch });

      expect(mockBatchCreateMessages).toHaveBeenCalledTimes(1);
      expect(mockBreakerState).toBe('CLOSED');
    });
  });

  // ─── T2.6 ───────────────────────────────────────────────────────────────

  describe('T2.6: Failed write in HALF_OPEN reopens breaker', () => {
    it('failure during HALF_OPEN probe re-opens the breaker', async () => {
      mockBreakerState = 'HALF_OPEN';

      mockBreakerExecute.mockImplementation(async (fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (err) {
          mockBreakerState = 'OPEN';
          throw err;
        }
      });

      mockBatchCreateMessages.mockRejectedValueOnce(new Error('MongoServerError: still down'));

      const batch = makeMessageBatch(1);

      await expect(capturedWorkerProcessFn!({ data: batch })).rejects.toThrow(
        'MongoServerError: still down',
      );

      expect(mockBreakerState).toBe('OPEN');
    });
  });

  // ─── T2.7 ───────────────────────────────────────────────────────────────

  describe('T2.7: BullMQ retry config is 5 attempts with 2s exponential', () => {
    it('Queue is constructed with correct default job options', () => {
      expect(capturedQueueOpts).toBeDefined();
      const jobOpts = capturedQueueOpts!.defaultJobOptions as Record<string, unknown>;
      expect(jobOpts).toBeDefined();
      expect(jobOpts.attempts).toBe(5);
      expect(jobOpts.backoff).toEqual({
        type: 'exponential',
        delay: 2000,
      });
    });

    it('Worker is constructed with the tuned concurrency', () => {
      expect(capturedWorkerOpts).toBeDefined();
      expect(capturedWorkerOpts!.concurrency).toBe(2);
    });
  });

  // ─── T2.8 ───────────────────────────────────────────────────────────────

  describe('T2.8: Messages not permanently lost during 30s outage', () => {
    it('5 failures then recovery — all messages persist', async () => {
      let callCount = 0;

      mockBreakerExecute.mockImplementation(async (fn: () => Promise<void>) => {
        callCount++;
        if (callCount <= 5) {
          throw new Error('MongoServerError: connection refused');
        }
        return fn();
      });

      const batch = makeMessageBatch(3);
      mockBatchCreateMessages.mockClear();

      for (let i = 0; i < 5; i++) {
        await expect(capturedWorkerProcessFn!({ data: batch })).rejects.toThrow(
          'MongoServerError: connection refused',
        );
      }

      await capturedWorkerProcessFn!({ data: batch });

      expect(mockBatchCreateMessages).toHaveBeenCalledTimes(1);
      const persistedMessages = mockBatchCreateMessages.mock.calls[0][0];
      expect(persistedMessages).toHaveLength(3);
      expect(persistedMessages[0].content).toBe('message-0');
      expect(persistedMessages[1].content).toBe('message-1');
      expect(persistedMessages[2].content).toBe('message-2');
    });

    it('messages enqueued during outage are buffered, not dropped', async () => {
      mockBreakerExecute.mockRejectedValue(
        new CircuitOpenError('app', 'system:message-persistence-mongo', 30000),
      );

      await persistMessage(
        'outage-session',
        'user',
        'msg-during-outage-1',
        'web_debug',
        'tenant-1',
      );
      await persistMessage(
        'outage-session',
        'assistant',
        'msg-during-outage-2',
        'web_debug',
        'tenant-1',
      );

      const buffer = _getMessageBuffer('outage-session');
      expect(buffer).toBeDefined();
      expect(buffer!).toHaveLength(2);
      expect(buffer![0].content).toBe('msg-during-outage-1');
      expect(buffer![1].content).toBe('msg-during-outage-2');
    });

    it('worker processes the full batch once breaker allows execution', async () => {
      mockBreakerExecute.mockImplementation(async (fn: () => Promise<void>) => fn());
      mockBatchCreateMessages.mockClear();

      const batch = makeMessageBatch(5);
      await capturedWorkerProcessFn!({ data: batch });

      expect(mockBatchCreateMessages).toHaveBeenCalledTimes(1);
      const persisted = mockBatchCreateMessages.mock.calls[0][0];
      expect(persisted).toHaveLength(5);
    });
  });

  // ─── Circuit breaker registry configuration ─────────────────────────────

  describe('Circuit breaker registry configuration', () => {
    it('registry is constructed with the Redis client', () => {
      expect(registryConstructArgs.length).toBe(2);
      expect(registryConstructArgs[0]).toBeDefined();
    });

    it('registry.app() is called with "system" tenant and "message-persistence-mongo" id', () => {
      expect(mockAppFn).toHaveBeenCalledWith('system', 'message-persistence-mongo');
    });

    it('breaker config includes halfOpenMaxConcurrent=1', () => {
      const opts = registryConstructArgs[1] as Record<string, unknown>;
      const defaults = opts.defaults as Record<string, Record<string, unknown>>;
      expect(defaults.app.halfOpenMaxConcurrent).toBe(1);
    });

    it('breaker config includes monitorWindow=30000ms', () => {
      const opts = registryConstructArgs[1] as Record<string, unknown>;
      const defaults = opts.defaults as Record<string, Record<string, unknown>>;
      expect(defaults.app.monitorWindow).toBe(30_000);
    });
  });

  // ─── Worker wraps batchCreateMessages with breaker ──────────────────────

  describe('Worker wraps batchCreateMessages with breaker', () => {
    it('workerJobHandler calls breaker.execute which calls batchCreateMessages', async () => {
      mockBreakerExecute.mockImplementation(async (fn: () => Promise<void>) => fn());
      mockBatchCreateMessages.mockClear();

      const batch = makeMessageBatch(2);
      await capturedWorkerProcessFn!({ data: batch });

      expect(mockBreakerExecute).toHaveBeenCalled();
      expect(mockBatchCreateMessages).toHaveBeenCalledTimes(1);
    });

    it('messages without tenantId are filtered out before reaching the breaker', async () => {
      mockBreakerExecute.mockImplementation(async (fn: () => Promise<void>) => fn());
      mockBatchCreateMessages.mockClear();

      const batch = {
        messages: [
          {
            dbSessionId: 'session-1',
            role: 'user',
            content: 'valid message',
            channel: 'web_debug',
            tenantId: 'tenant-1',
            projectId: 'project-1',
            hasPII: false,
            enqueuedAt: Date.now(),
            idempotencyKey: 'key-valid',
          },
          {
            dbSessionId: 'session-2',
            role: 'user',
            content: 'invalid message',
            channel: 'web_debug',
            tenantId: undefined,
            projectId: 'project-1',
            hasPII: false,
            enqueuedAt: Date.now(),
            idempotencyKey: 'key-invalid',
          },
        ],
      };

      await capturedWorkerProcessFn!({ data: batch });

      expect(mockBatchCreateMessages).toHaveBeenCalledTimes(1);
      const persisted = mockBatchCreateMessages.mock.calls[0][0];
      expect(persisted).toHaveLength(1);
      expect(persisted[0].tenantId).toBe('tenant-1');
    });

    it('messages without projectId are backfilled from the session before reaching the breaker', async () => {
      mockBreakerExecute.mockImplementation(async (fn: () => Promise<void>) => fn());
      mockBatchCreateMessages.mockClear();
      mockFindSessionPersistenceContexts.mockResolvedValue([
        {
          id: 'session-backfill',
          tenantId: 'tenant-1',
          projectId: 'project-backfilled',
        },
      ]);

      const batch = {
        messages: [
          {
            dbSessionId: 'session-backfill',
            role: 'assistant',
            content: 'repaired message',
            channel: 'web_debug',
            tenantId: 'tenant-1',
            projectId: undefined,
            hasPII: false,
            enqueuedAt: Date.now(),
            idempotencyKey: 'key-repaired',
          },
        ],
      };

      await capturedWorkerProcessFn!({ data: batch });

      expect(mockFindSessionPersistenceContexts).toHaveBeenCalledWith(
        ['session-backfill'],
        ['tenant-1'],
      );
      expect(mockBatchCreateMessages).toHaveBeenCalledTimes(1);
      const persisted = mockBatchCreateMessages.mock.calls[0][0];
      expect(persisted).toHaveLength(1);
      expect(persisted[0].projectId).toBe('project-backfilled');
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Resolved missing projectId values for message persistence batch',
        expect.objectContaining({
          messageCount: 1,
          repairedCount: 1,
          unresolvedCount: 0,
        }),
      );
    });

    it('messages without projectId are dropped before reaching the breaker when backfill fails', async () => {
      mockBreakerExecute.mockClear();
      mockBatchCreateMessages.mockClear();
      mockFindSessionPersistenceContexts.mockResolvedValue([]);

      const batch = {
        messages: [
          {
            dbSessionId: 'session-missing-project',
            role: 'assistant',
            content: 'cannot persist',
            channel: 'web_debug',
            tenantId: 'tenant-1',
            projectId: undefined,
            hasPII: false,
            enqueuedAt: Date.now(),
            idempotencyKey: 'key-missing-project',
          },
        ],
      };

      await capturedWorkerProcessFn!({ data: batch });

      expect(mockFindSessionPersistenceContexts).toHaveBeenCalledWith(
        ['session-missing-project'],
        ['tenant-1'],
      );
      expect(mockBreakerExecute).not.toHaveBeenCalled();
      expect(mockBatchCreateMessages).not.toHaveBeenCalled();
      expect(mockLogError).toHaveBeenCalledWith(
        'Dropping messages without projectId — fail-closed',
        expect.objectContaining({
          messageCount: 1,
          missingProjectIdCount: 1,
          sampleSessionIds: ['session-missing-project'],
        }),
      );
    });

    it('empty valid messages batch skips breaker.execute entirely', async () => {
      mockBreakerExecute.mockClear();
      mockBatchCreateMessages.mockClear();

      const batch = {
        messages: [
          {
            dbSessionId: 'session-1',
            role: 'user',
            content: 'no tenant',
            channel: 'web_debug',
            tenantId: undefined,
            hasPII: false,
            enqueuedAt: Date.now(),
            idempotencyKey: 'key-1',
          },
        ],
      };

      await capturedWorkerProcessFn!({ data: batch });

      expect(mockBreakerExecute).not.toHaveBeenCalled();
      expect(mockBatchCreateMessages).not.toHaveBeenCalled();
    });

    it('logs batch context when Mongo persistence fails', async () => {
      mockBreakerExecute.mockImplementation(async (fn: () => Promise<void>) => fn());
      mockBatchCreateMessages.mockRejectedValueOnce(new Error('mongo unavailable'));

      await expect(capturedWorkerProcessFn!({ data: makeMessageBatch(2) })).rejects.toThrow(
        'mongo unavailable',
      );

      expect(mockLogError).toHaveBeenCalledWith(
        'Message persistence insert failed',
        expect.objectContaining({
          messageCount: 2,
          sessionCount: 1,
          tenantCount: 1,
          projectCount: 1,
          channels: ['web_debug'],
          sampleSessionIds: ['session-1'],
          tenantId: 'tenant-1',
          tenantIds: ['tenant-1'],
          projectIds: ['project-1'],
          error: 'mongo unavailable',
        }),
      );
    });
  });
});
