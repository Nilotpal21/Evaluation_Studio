/**
 * Message Persistence Queue — extended coverage
 *
 * Tests enqueueing, batching, flush behavior, metrics recording,
 * error handling, and queue lifecycle for the message persistence queue.
 *
 * All tests use the direct-write fallback path (Redis unavailable)
 * unless explicitly testing the BullMQ buffer path via _setBullAvailable().
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ── Shared mock state ──────────────────────────────────────────────────────

const directWriteMessages: Array<{
  sessionId: string;
  role: string;
  content: string;
  contentEnvelope?: string;
  channel?: string;
  traceId?: string;
  tenantId?: string;
  projectId?: string;
  contactId?: string;
  metadata?: Record<string, unknown>;
}> = [];
let addMessageImpl: (msg: any) => Promise<void> = async (msg) => {
  directWriteMessages.push(msg);
};

let dbAvailable = true;

// ── Logger mock ────────────────────────────────────────────────────────────

const { mockLogInfo, mockLogWarn, mockLogError } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));
const { mockContainsPII, mockRedactPII } = vi.hoisted(() => ({
  mockContainsPII: vi.fn(),
  mockRedactPII: vi.fn(),
}));
const { mockResolveProjectPIISnapshot } = vi.hoisted(() => ({
  mockResolveProjectPIISnapshot: vi.fn(),
}));
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    child: vi.fn(),
    setCorrelationId: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database/models', () => ({}));

vi.mock('@abl/compiler', () => ({
  containsPII: (...args: any[]) => mockContainsPII(...args),
  redactPII: (...args: any[]) => mockRedactPII(...args),
}));

vi.mock('../services/pii/session-pii-context.js', () => ({
  createPIIVaultForProjectSnapshot: vi.fn(),
  resolveProjectPIISnapshot: vi.fn(),
  resolveProjectPIISnapshot: (...args: any[]) => mockResolveProjectPIISnapshot(...args),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => dbAvailable),
}));

vi.mock('../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    message: {
      addMessage: (msg: any) => addMessageImpl(msg),
    },
  })),
}));

const mockBatchCreateMessages = vi.fn().mockResolvedValue(undefined);
const mockApplySessionTurnUpdate = vi.fn().mockResolvedValue(undefined);
const mockFindSessionPersistenceContexts = vi.fn().mockResolvedValue([]);
const mockWithTransaction = vi.fn(async (fn: (session: unknown) => Promise<unknown>) => fn(null));

vi.mock('../repos/session-repo.js', () => ({
  batchCreateMessages: (...args: any[]) => mockBatchCreateMessages(...args),
  applySessionTurnUpdate: (...args: any[]) => mockApplySessionTurnUpdate(...args),
  findSessionPersistenceContexts: (...args: any[]) => mockFindSessionPersistenceContexts(...args),
}));

vi.mock('@agent-platform/shared/repos', () => ({
  withTransaction: (...args: any[]) => mockWithTransaction(...args),
}));

// shared-auth ALS — pass-through for direct-write tests
vi.mock('@agent-platform/shared-auth/middleware', () => ({
  runWithTenantContext: (_ctx: any, fn: () => any) => fn(),
  getTenantContextData: () => undefined,
}));

vi.mock('@agent-platform/database/mongo', () => ({
  getCurrentTenantContext: () => undefined,
}));

vi.mock('../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: vi.fn().mockResolvedValue({
      security: { scrubPII: false },
      limits: { messageRetentionDays: 90 },
    }),
    resolveProjectMessageRetention: vi.fn().mockResolvedValue(null),
  }),
  PLAN_LIMITS: { TEAM: { messageRetentionDays: 90 } },
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  isTenantEncryptionReady: () => true,
  encryptForTenantAuto: async (plaintext: string) => plaintext,
  decryptForTenantAuto: async (ciphertext: string) => ciphertext,
  wrapJobDataForEncrypt: async (_purpose: string, data: unknown) => data,
  unwrapJobDataForDecrypt: async (_purpose: string, data: unknown) => data,
}));

// Redis unavailable — forces direct-write fallback path
vi.mock('../services/redis/redis-client.js', () => ({
  isRedisAvailable: () => false,
  getRedisClient: () => null,
  getRedisHandle: () => null,
}));

// ── Import module under test ───────────────────────────────────────────────

import {
  persistMessage,
  persistMessageRecord,
  persistScopedMessage,
  persistScopedTurnMetrics,
  persistTurnMetrics,
  flushMessageQueue,
  shutdownMessageQueue,
  _resetForTest,
  _getMessageBuffer,
  _setBullAvailable,
  _setBullQueueForTest,
  _processBatchForTest,
  _getMetricsBufferSize,
  MAX_METRICS_BUFFER,
  type TurnMetrics,
} from '../services/message-persistence-queue.js';
import type { ProductionExecutionScope } from '../services/session/execution-scope.js';

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Message Persistence Queue — extended coverage', () => {
  const buildProductionScope = (
    overrides: Partial<ProductionExecutionScope> = {},
  ): ProductionExecutionScope => ({
    kind: 'production',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'runtime-session-1',
    sessionPrincipalId: 'principal-1',
    channelId: 'sdk',
    environment: 'prod',
    source: 'sdk',
    authType: 'sdk_session',
    traceId: 'trace-1',
    actor: { kind: 'contact', contactId: 'contact-1' },
    subject: { kind: 'contact', contactId: 'contact-1' },
    identityEvidence: {
      identityTier: 1,
      verificationMethod: 'sdk_bootstrap',
      artifacts: [{ type: 'external', valueHash: 'hash-1' }],
    },
    callerContext: {},
    ...overrides,
  });

  beforeEach(() => {
    _resetForTest();
    directWriteMessages.length = 0;
    dbAvailable = true;
    addMessageImpl = async (msg) => {
      directWriteMessages.push(msg);
    };
    mockBatchCreateMessages.mockReset().mockResolvedValue(undefined);
    mockApplySessionTurnUpdate.mockReset().mockResolvedValue(undefined);
    mockFindSessionPersistenceContexts.mockReset().mockResolvedValue([]);
    mockWithTransaction.mockReset().mockImplementation(async (fn) => fn(null));
    mockLogInfo.mockReset();
    mockLogWarn.mockReset();
    mockLogError.mockReset();
    mockContainsPII
      .mockReset()
      .mockImplementation((content: string) => content.includes('123-45-6789'));
    mockRedactPII
      .mockReset()
      .mockImplementation((content: string) => content.replace('123-45-6789', '[REDACTED]'));
    mockResolveProjectPIISnapshot.mockReset().mockResolvedValue({
      piiRedactionConfig: {
        enabled: true,
        redactInput: false,
        redactOutput: false,
      },
      piiRecognizerRegistry: { mocked: true },
      piiPatternConfigs: [],
    });
  });

  // ─── Message enqueueing ────────────────────────────────────────────────

  describe('Message enqueueing', () => {
    it('persistScopedMessage rejects missing project scope before direct write fallback', async () => {
      await expect(
        persistScopedMessage({
          scope: buildProductionScope({ projectId: '' }),
          message: {
            dbSessionId: 'db-session-1',
            role: 'user',
            content: 'hello world',
            channel: 'web_debug',
          },
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_SESSION_SCOPE',
        details: expect.objectContaining({
          field: 'projectId',
        }),
      });

      expect(directWriteMessages).toHaveLength(0);
    });

    it('persistScopedMessage rejects unsupported non-production scope kinds', async () => {
      await expect(
        persistScopedMessage({
          scope: buildProductionScope({
            kind: 'debug',
          } as unknown as Partial<ProductionExecutionScope>),
          message: {
            dbSessionId: 'db-session-1',
            role: 'user',
            content: 'hello world',
            channel: 'web_debug',
          },
        }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_SCOPE_KIND',
        details: expect.objectContaining({
          field: 'kind',
        }),
      });

      expect(directWriteMessages).toHaveLength(0);
    });

    it('persistScopedMessage rejects an empty scoped dbSessionId', async () => {
      await expect(
        persistScopedMessage({
          scope: buildProductionScope(),
          message: {
            dbSessionId: '',
            role: 'user',
            content: 'hello world',
            channel: 'web_debug',
          },
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_SESSION_SCOPE',
        details: expect.objectContaining({
          field: 'message.dbSessionId',
        }),
      });

      expect(directWriteMessages).toHaveLength(0);
    });

    it('persistScopedMessage preserves canonical subject and scope traceId for direct write', async () => {
      await persistScopedMessage({
        scope: buildProductionScope({
          tenantId: 'tenant-42',
          projectId: 'project-42',
          traceId: 'trace-from-scope',
          subject: { kind: 'contact', contactId: 'contact-42' },
        }),
        message: {
          dbSessionId: 'db-session-42',
          role: 'assistant',
          content: 'scoped write',
          channel: 'sdk',
        },
      });

      expect(directWriteMessages).toHaveLength(1);
      expect(directWriteMessages[0]).toMatchObject({
        sessionId: 'db-session-42',
        traceId: 'trace-from-scope',
        contactId: 'contact-42',
        tenantId: 'tenant-42',
        projectId: 'project-42',
      });
    });

    it('persistScopedMessage preserves response provenance metadata on direct write', async () => {
      const metadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      };

      await persistScopedMessage({
        scope: buildProductionScope(),
        message: {
          dbSessionId: 'db-session-provenance',
          role: 'assistant',
          content: 'Generated reply',
          metadata,
          channel: 'sdk',
        },
      });

      expect(directWriteMessages).toHaveLength(1);
      expect(directWriteMessages[0].metadata).toEqual(metadata);
    });

    it('serializes structured assistant content into the durable contentEnvelope', async () => {
      await persistScopedMessage({
        scope: buildProductionScope(),
        message: {
          dbSessionId: 'db-session-structured',
          role: 'assistant',
          content: 'Structured direct write',
          structuredContent: {
            richContent: { markdown: '**Structured direct write**' },
            actions: {
              elements: [{ id: 'ack', type: 'button', label: 'Acknowledge' }],
            },
            voiceConfig: { plain_text: 'Structured direct write' },
          },
          channel: 'sdk',
        },
      });

      expect(directWriteMessages).toHaveLength(1);
      expect(directWriteMessages[0].contentEnvelope).toBeDefined();
      expect(JSON.parse(directWriteMessages[0].contentEnvelope ?? '{}')).toMatchObject({
        version: 2,
        format: 'message_envelope',
        text: 'Structured direct write',
        richContent: { markdown: '**Structured direct write**' },
        actions: {
          elements: [{ id: 'ack', type: 'button', label: 'Acknowledge' }],
        },
        voiceConfig: { plain_text: 'Structured direct write' },
      });
    });

    it('persistMessage stores message in internal buffer (BullMQ path)', async () => {
      _setBullAvailable(true);

      await persistMessage('sess-1', 'user', 'hello world');

      const buffer = _getMessageBuffer('sess-1');
      expect(buffer).toBeDefined();
      expect(buffer).toHaveLength(1);
      expect(buffer![0].role).toBe('user');
      expect(buffer![0].content).toBe('hello world');
      expect(buffer![0].dbSessionId).toBe('sess-1');
      expect(buffer![0].hasPII).toBe(false);
      expect(typeof buffer![0].enqueuedAt).toBe('number');
    });

    it('persistMessage stores response provenance metadata in the BullMQ buffer', async () => {
      _setBullAvailable(true);

      await persistMessage(
        'sess-1',
        'assistant',
        'hello world',
        'web_chat',
        'tenant-1',
        'trace-1',
        'contact-1',
        'project-1',
        Date.now(),
        undefined,
        {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      );

      const buffer = _getMessageBuffer('sess-1');
      expect(buffer).toBeDefined();
      expect(buffer![0].metadata).toEqual({
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      });
    });

    it('persistMessage batches multiple messages for the same session', async () => {
      _setBullAvailable(true);

      await persistMessage('sess-1', 'user', 'message one');
      await persistMessage('sess-1', 'assistant', 'message two');
      await persistMessage('sess-1', 'user', 'message three');

      const buffer = _getMessageBuffer('sess-1');
      expect(buffer).toBeDefined();
      expect(buffer).toHaveLength(3);
      expect(buffer![0].content).toBe('message one');
      expect(buffer![1].content).toBe('message two');
      expect(buffer![2].content).toBe('message three');
    });

    it('persistMessage creates separate batches for different sessions', async () => {
      _setBullAvailable(true);

      await persistMessage('sess-A', 'user', 'A msg');
      await persistMessage('sess-B', 'user', 'B msg');
      await persistMessage('sess-A', 'assistant', 'A reply');

      const bufferA = _getMessageBuffer('sess-A');
      const bufferB = _getMessageBuffer('sess-B');

      expect(bufferA).toHaveLength(2);
      expect(bufferB).toHaveLength(1);
      expect(bufferA![0].content).toBe('A msg');
      expect(bufferA![1].content).toBe('A reply');
      expect(bufferB![0].content).toBe('B msg');
    });

    it('persistMessage detects PII via containsPII from compiler', async () => {
      _setBullAvailable(true);

      // Content containing a SSN pattern — containsPII detects this
      await persistMessage('sess-1', 'user', 'My SSN is 123-45-6789');

      const buffer = _getMessageBuffer('sess-1');
      expect(buffer).toBeDefined();
      expect(buffer![0].hasPII).toBe(true);
    });

    it('persistMessage uses direct write when BullMQ is not available', async () => {
      // Default: BullMQ not available (Redis mocked as unavailable)
      await persistMessage(
        'sess-1',
        'user',
        'direct write msg',
        'web_debug',
        'tenant-1',
        'trace-1',
      );

      expect(directWriteMessages).toHaveLength(1);
      expect(directWriteMessages[0].sessionId).toBe('sess-1');
      expect(directWriteMessages[0].role).toBe('user');
      expect(directWriteMessages[0].content).toBe('direct write msg');
    });

    it('persistMessage preserves explicit metadata on direct writes', async () => {
      await persistMessage(
        'sess-1',
        'assistant',
        'transferred reply',
        'web_debug',
        'tenant-1',
        'trace-1',
        'contact-1',
        'project-1',
        undefined,
        undefined,
        {
          voiceType: 'tts',
          custom: {
            source: 'agent-transfer',
            transferSessionId: 'agent_transfer:tenant-1:sess-1:chat',
          },
        },
      );

      expect(directWriteMessages).toHaveLength(1);
      expect(directWriteMessages[0].metadata).toEqual({
        voiceType: 'tts',
        custom: {
          source: 'agent-transfer',
          transferSessionId: 'agent_transfer:tenant-1:sess-1:chat',
        },
      });
    });

    it('logs missing projectId context before direct write fallback', async () => {
      await persistMessage(
        'sess-1',
        'user',
        'direct write msg',
        'web_debug',
        'tenant-1',
        'trace-1',
      );

      expect(mockLogWarn).toHaveBeenCalledWith(
        'Persist message missing projectId context',
        expect.objectContaining({
          stage: 'direct-write',
          role: 'user',
          channels: ['web_debug'],
          sampleSessionIds: ['sess-1'],
          missingProjectIdCount: 1,
          hasTraceId: true,
        }),
      );
    });

    it('persistMessage is a no-op when database is unavailable', async () => {
      dbAvailable = false;

      await persistMessage('sess-1', 'user', 'should be ignored');

      expect(directWriteMessages).toHaveLength(0);
      const buffer = _getMessageBuffer('sess-1');
      expect(buffer).toBeUndefined();
    });
  });

  // ─── Flush behavior ───────────────────────────────────────────────────

  describe('Flush behavior', () => {
    it('flushMessageQueue with empty queue is a no-op (no BullMQ)', async () => {
      // No BullMQ = no buffering = nothing to flush
      await expect(flushMessageQueue()).resolves.toBeUndefined();
    });

    it('flushMessageQueue for specific session only flushes that session', async () => {
      _setBullAvailable(true);

      await persistMessage('sess-A', 'user', 'A msg');
      await persistMessage('sess-B', 'user', 'B msg');

      // We cannot truly flush because bullQueue is null in our mock,
      // but we can verify that calling flush with a session ID removes
      // only that session's buffer. Since bullQueue is null (we only set
      // bullAvailable flag), flushMessageQueue returns early.
      // To test this path we need to verify the buffer manipulation.
      // The function checks `if (!bullQueue) return;` so with no real queue
      // this test verifies the guard clause.
      await flushMessageQueue('sess-A');

      // Both buffers still exist because bullQueue is null and flush returns early
      const bufferA = _getMessageBuffer('sess-A');
      const bufferB = _getMessageBuffer('sess-B');
      expect(bufferA).toHaveLength(1); // Not flushed because no bullQueue
      expect(bufferB).toHaveLength(1);
    });

    it('flushMessageQueue without sessionId returns early when no bullQueue', async () => {
      _setBullAvailable(true);

      await persistMessage('sess-1', 'user', 'msg');

      // No real bullQueue instance, so flushAllBuffers returns early
      await expect(flushMessageQueue()).resolves.toBeUndefined();

      // Buffer still intact because flushAllBuffers guards on !bullQueue
      const buffer = _getMessageBuffer('sess-1');
      expect(buffer).toHaveLength(1);
    });

    it('flushMessageQueue waits for in-flight session persists before draining buffers', async () => {
      _setBullAvailable(true);
      const addJob = vi.fn(async () => undefined);
      _setBullQueueForTest({ add: addJob, addBulk: vi.fn(async () => []) });

      let resolveSnapshot!: (value: {
        piiRedactionConfig: { enabled: boolean; redactInput: boolean; redactOutput: boolean };
        piiRecognizerRegistry: Record<string, unknown>;
        piiPatternConfigs: unknown[];
      }) => void;
      mockResolveProjectPIISnapshot.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
      );

      const persistPromise = persistMessage(
        'sess-pending-flush',
        'user',
        'pending closeout message',
        'web_debug',
        'tenant-1',
        'trace-1',
        'contact-1',
        'project-1',
      );

      await vi.waitFor(() => expect(mockResolveProjectPIISnapshot).toHaveBeenCalledTimes(1));
      const flushPromise = flushMessageQueue('sess-pending-flush');

      resolveSnapshot({
        piiRedactionConfig: {
          enabled: true,
          redactInput: false,
          redactOutput: false,
        },
        piiRecognizerRegistry: { mocked: true },
        piiPatternConfigs: [],
      });

      await Promise.all([persistPromise, flushPromise]);

      expect(_getMessageBuffer('sess-pending-flush')).toBeUndefined();
      expect(addJob).toHaveBeenCalledWith(
        'message-batch',
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              dbSessionId: 'sess-pending-flush',
              content: 'pending closeout message',
            }),
          ],
        }),
      );
    });

    it('worker batch persistence writes response provenance metadata as an object', async () => {
      const metadata = {
        isLlmGenerated: false,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'scripted',
          disclaimerRequired: false,
          usedLlmInternally: true,
        },
      };

      await _processBatchForTest({
        messages: [
          {
            dbSessionId: 'sess-batch-provenance',
            role: 'assistant',
            content: 'Buffered reply',
            channel: 'web_chat',
            tenantId: 'tenant-1',
            projectId: 'project-1',
            metadata,
            hasPII: false,
            enqueuedAt: Date.now(),
            idempotencyKey: 'idem-provenance-batch',
          },
        ],
      });

      // Messages are inserted without a transaction (no session param)
      expect(mockBatchCreateMessages).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            sessionId: 'sess-batch-provenance',
            tenantId: 'tenant-1',
            projectId: 'project-1',
            role: 'assistant',
            metadata,
          }),
        ],
        { tenantId: 'tenant-1' },
      );
      // Turn update runs independently (no session param)
      expect(mockApplySessionTurnUpdate).toHaveBeenCalledWith(
        'sess-batch-provenance',
        expect.objectContaining({
          messageCountIncrement: 1,
          touchLastActivityAt: true,
        }),
        'tenant-1',
        { requireMatched: true },
      );
    });

    it('swallows turn update failure after successful message insert', async () => {
      mockApplySessionTurnUpdate.mockRejectedValueOnce(new Error('turn update failed'));

      // Batch should resolve — messages are persisted, turn update failure is logged but swallowed
      await expect(
        _processBatchForTest({
          messages: [
            {
              dbSessionId: 'sess-turn-fail',
              role: 'assistant',
              content: 'Buffered reply',
              channel: 'web_chat',
              tenantId: 'tenant-1',
              projectId: 'project-1',
              hasPII: false,
              enqueuedAt: Date.now(),
              idempotencyKey: 'idem-turn-fail',
            },
          ],
        }),
      ).resolves.not.toThrow();

      // Messages were still inserted
      expect(mockBatchCreateMessages).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            sessionId: 'sess-turn-fail',
            tenantId: 'tenant-1',
          }),
        ],
        { tenantId: 'tenant-1' },
      );
      // Turn update was attempted
      expect(mockApplySessionTurnUpdate).toHaveBeenCalledWith(
        'sess-turn-fail',
        expect.objectContaining({
          messageCountIncrement: 1,
        }),
        'tenant-1',
        { requireMatched: true },
      );
    });
  });

  // ─── Metrics recording ────────────────────────────────────────────────

  describe('Metrics recording', () => {
    it('persistScopedTurnMetrics rejects missing project scope before direct-write fallback', async () => {
      await expect(
        persistScopedTurnMetrics({
          scope: buildProductionScope({ projectId: '' }),
          metrics: {
            dbSessionId: 'db-session-1',
            tokensIn: 10,
            tokensOut: 20,
            cost: 0.01,
            traceEventCount: 1,
            errorCount: 0,
            handoffCount: 0,
          },
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_SESSION_SCOPE',
        details: expect.objectContaining({
          field: 'projectId',
        }),
      });

      expect(mockApplySessionTurnUpdate).not.toHaveBeenCalled();
    });

    it('persistTurnMetrics applies a combined session turn update on direct-write fallback', async () => {
      const metrics: TurnMetrics = {
        dbSessionId: 'sess-1',
        tenantId: 'tenant-1',
        tokensIn: 100,
        tokensOut: 200,
        cost: 0.05,
        traceEventCount: 3,
        errorCount: 0,
        handoffCount: 1,
      };

      await persistTurnMetrics(metrics);

      expect(mockApplySessionTurnUpdate).toHaveBeenCalledWith(
        'sess-1',
        {
          tokenCountIncrement: 300,
          estimatedCostIncrement: 0.05,
          traceEventCountIncrement: 3,
          errorCountIncrement: 0,
          handoffCountIncrement: 1,
          touchLastActivityAt: true,
        },
        'tenant-1',
      );
    });

    it('persistTurnMetrics with all-zero values is a no-op', async () => {
      const metrics: TurnMetrics = {
        dbSessionId: 'sess-1',
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        traceEventCount: 0,
        errorCount: 0,
        handoffCount: 0,
      };

      await persistTurnMetrics(metrics);

      // hasUpdates check: (0+0) > 0 || 0 > 0 || 0 > 0 || 0 > 0 = false
      expect(mockApplySessionTurnUpdate).not.toHaveBeenCalled();
    });

    it('persistTurnMetrics with zero tokens but nonzero traceEventCount still writes', async () => {
      const metrics: TurnMetrics = {
        dbSessionId: 'sess-1',
        tenantId: 'tenant-1',
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        traceEventCount: 5,
        errorCount: 0,
        handoffCount: 0,
      };

      await persistTurnMetrics(metrics);

      expect(mockApplySessionTurnUpdate).toHaveBeenCalledWith(
        'sess-1',
        {
          tokenCountIncrement: 0,
          estimatedCostIncrement: 0,
          traceEventCountIncrement: 5,
          errorCountIncrement: 0,
          handoffCountIncrement: 0,
          touchLastActivityAt: true,
        },
        'tenant-1',
      );
    });

    it('persistTurnMetrics is a no-op when database is unavailable', async () => {
      dbAvailable = false;

      const metrics: TurnMetrics = {
        dbSessionId: 'sess-1',
        tokensIn: 500,
        tokensOut: 100,
        cost: 1.0,
        traceEventCount: 10,
        errorCount: 1,
        handoffCount: 0,
      };

      await persistTurnMetrics(metrics);

      expect(mockApplySessionTurnUpdate).not.toHaveBeenCalled();
    });
  });

  // ─── Error handling ────────────────────────────────────────────────────

  describe('Error handling', () => {
    it('DB write failure during direct persist is caught and logged', async () => {
      addMessageImpl = async () => {
        throw new Error('DB connection lost');
      };

      // Should not throw — error is caught internally
      await expect(persistMessage('sess-1', 'user', 'will fail')).resolves.toBeUndefined();

      expect(mockLogError).toHaveBeenCalledWith(
        'Direct write failed',
        expect.objectContaining({
          dbSessionId: 'sess-1',
          error: 'DB connection lost',
        }),
      );
    });

    it('applySessionTurnUpdate failure is swallowed (direct write fallback)', async () => {
      mockApplySessionTurnUpdate.mockRejectedValueOnce(new Error('Turn DB error'));

      const metrics: TurnMetrics = {
        dbSessionId: 'sess-1',
        tenantId: 'tenant-1',
        tokensIn: 10,
        tokensOut: 20,
        cost: 0.01,
        traceEventCount: 1,
        errorCount: 0,
        handoffCount: 0,
      };

      // Should not throw — the .catch() in the fallback swallows it
      await expect(persistTurnMetrics(metrics)).resolves.toBeUndefined();
    });

    it('persistTurnMetrics catches top-level error in direct write fallback', async () => {
      mockApplySessionTurnUpdate.mockImplementationOnce(() => {
        throw new Error('Sync failure');
      });

      const metrics: TurnMetrics = {
        dbSessionId: 'sess-1',
        tenantId: 'tenant-1',
        tokensIn: 10,
        tokensOut: 20,
        cost: 0.01,
        traceEventCount: 1,
        errorCount: 0,
        handoffCount: 0,
      };

      // The outer try/catch should swallow the error
      await expect(persistTurnMetrics(metrics)).resolves.toBeUndefined();

      expect(mockLogError).toHaveBeenCalledWith(
        'Direct metrics write failed',
        expect.objectContaining({
          error: 'Sync failure',
        }),
      );
    });
  });

  // ─── Queue lifecycle ──────────────────────────────────────────────────

  describe('Queue lifecycle', () => {
    it('shutdownMessageQueue resets internal state', async () => {
      // Use direct-write path (no BullMQ), so messages go to store directly
      // and shutdown clears the internal flags.
      await shutdownMessageQueue();

      // After shutdown, bullAvailable/bullInitAttempted are reset.
      // Verify by checking that _setBullAvailable + buffer is cleared by reset.
      _setBullAvailable(true);
      await persistMessage('sess-1', 'user', 'pre-shutdown');

      const bufferBefore = _getMessageBuffer('sess-1');
      expect(bufferBefore).toHaveLength(1);

      // shutdownMessageQueue calls flushAllBuffers which needs bullQueue (null here),
      // so it skips the flush. But it does reset: metricsBuffer, sessionChains,
      // bullAvailable, bullInitAttempted, and totalBuffered.
      // The messageBuffer is replaced inside flushAllBuffers only when bullQueue is set.
      // Since bullQueue is null, flushAllBuffers returns early and messageBuffer persists.
      // However, shutdownMessageQueue resets bullAvailable and bullInitAttempted.
      await shutdownMessageQueue();

      // After shutdown, bullAvailable is false so new persist calls use direct write.
      // The key state reset is that bullInitAttempted is false so BullMQ init
      // will be re-attempted on next persistMessage call.
      // Verify by persisting a new message: it should go through direct write.
      await persistMessage('sess-2', 'user', 'after shutdown');
      expect(directWriteMessages).toHaveLength(1);
      expect(directWriteMessages[0].content).toBe('after shutdown');
    });

    it('shutdownMessageQueue logs shutdown messages', async () => {
      await shutdownMessageQueue();

      expect(mockLogInfo).toHaveBeenCalledWith('Shutting down message queue');
      expect(mockLogInfo).toHaveBeenCalledWith('Message queue shutdown complete');
    });

    it('_resetForTest clears all buffers and state', () => {
      _setBullAvailable(true);
      // After reset, buffers should be empty
      _resetForTest();

      const buffer = _getMessageBuffer('any-session');
      expect(buffer).toBeUndefined();
    });

    it('multiple shutdowns in a row do not fail', async () => {
      await shutdownMessageQueue();
      await shutdownMessageQueue();
      await shutdownMessageQueue();

      // Should not throw — each shutdown emits 2 log.info calls
      expect(mockLogInfo).toHaveBeenCalledTimes(6); // 2 info lines x 3 calls
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('persistMessage uses default channel when none provided', async () => {
      await persistMessage('sess-1', 'user', 'no channel');

      expect(directWriteMessages).toHaveLength(1);
      // The channel passed to the store is the default 'web_debug'
      expect(directWriteMessages[0].channel).toBe('web_debug');
    });

    it('persistMessage passes tenantId and traceId through', async () => {
      _setBullAvailable(true);

      await persistMessage('sess-1', 'user', 'content', 'voice', 'tenant-42', 'trace-abc');

      const buffer = _getMessageBuffer('sess-1');
      expect(buffer).toBeDefined();
      expect(buffer![0].channel).toBe('voice');
      expect(buffer![0].tenantId).toBe('tenant-42');
      expect(buffer![0].traceId).toBe('trace-abc');
    });

    it('uses explicit message ids in idempotency keys for distinct assistant outputs', async () => {
      _setBullAvailable(true);

      await persistMessageRecord({
        dbSessionId: 'sess-output',
        role: 'assistant',
        content: 'same text',
        tenantId: 'tenant-1',
        messageTimestamp: 123_456,
        messageId: 'msg-one',
      });
      await persistMessageRecord({
        dbSessionId: 'sess-output',
        role: 'assistant',
        content: 'same text',
        tenantId: 'tenant-1',
        messageTimestamp: 123_456,
        messageId: 'msg-two',
      });

      const buffer = _getMessageBuffer('sess-output');
      expect(buffer).toHaveLength(2);
      expect(buffer?.map((message) => message.messageId)).toEqual(['msg-one', 'msg-two']);
      expect(buffer?.[0].idempotencyKey).not.toBe(buffer?.[1].idempotencyKey);
    });

    it('concurrent persists to same session preserve ordering', async () => {
      const results: string[] = [];
      addMessageImpl = async (msg) => {
        results.push(msg.content);
        directWriteMessages.push(msg);
      };

      // Fire 5 concurrent persists
      const promises = [
        persistMessage('sess-1', 'user', 'first'),
        persistMessage('sess-1', 'assistant', 'second'),
        persistMessage('sess-1', 'user', 'third'),
        persistMessage('sess-1', 'assistant', 'fourth'),
        persistMessage('sess-1', 'user', 'fifth'),
      ];

      await Promise.all(promises);

      expect(results).toEqual(['first', 'second', 'third', 'fourth', 'fifth']);
    });
  });

  // ─── Backpressure and drop assertions ────────────────────────────────────

  describe('Backpressure and drop assertions', () => {
    it('buffer reaching MAX_BATCH_SIZE (25) triggers an immediate flush', async () => {
      const addBulkFn = vi.fn(async () => []);
      _setBullAvailable(true);
      _setBullQueueForTest({ add: vi.fn(), addBulk: addBulkFn });

      // Enqueue 24 messages — should buffer without flushing
      for (let i = 0; i < 24; i++) {
        await persistMessage('sess-bp', 'user', `msg-${i}`, 'web_debug', 'tenant-1');
      }
      expect(addBulkFn).not.toHaveBeenCalled();
      expect(_getMessageBuffer('sess-bp')).toHaveLength(24);

      // The 25th message pushes the per-session buffer to MAX_BATCH_SIZE and triggers flush
      await persistMessage('sess-bp', 'user', 'msg-24', 'web_debug', 'tenant-1');

      expect(addBulkFn).toHaveBeenCalledTimes(1);
      const jobs = addBulkFn.mock.calls[0][0] as Array<{ data: { messages: unknown[] } }>;
      expect(jobs[0].data.messages).toHaveLength(25);
      // Buffer must be empty after flush
      expect(_getMessageBuffer('sess-bp')).toBeUndefined();
    });

    it('BullMQ failure after atomic swap logs error with drop count and messages are lost', async () => {
      const flushError = new Error('BullMQ unavailable');
      _setBullAvailable(true);
      _setBullQueueForTest({
        add: vi.fn(),
        addBulk: vi.fn(async () => Promise.reject(flushError)),
      });

      // Fill to 24
      for (let i = 0; i < 24; i++) {
        await persistMessage('sess-drop', 'user', `msg-${i}`, 'web_debug', 'tenant-1');
      }

      // The 25th triggers flushAllBuffers which fails after the atomic swap.
      // The per-session chain guard swallows the error so persistMessage always resolves.
      await persistMessage('sess-drop', 'user', 'msg-24', 'web_debug', 'tenant-1');

      // Buffer was atomically swapped before the add failed — messages are permanently lost
      expect(_getMessageBuffer('sess-drop')).toBeUndefined();
      // Direct store must NOT have received the messages (no fallback write)
      expect(directWriteMessages).toHaveLength(0);
      // flushAllBuffers logs the drop count before re-throwing
      expect(mockLogError).toHaveBeenCalledWith(
        'Flush failed — messages dropped',
        expect.objectContaining({ droppedMessages: 25 }),
      );
      // The session chain guard also logs a warning for the failed persist
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Message persist failed',
        expect.objectContaining({ dbSessionId: 'sess-drop' }),
      );
    });

    it('metrics eviction at MAX_METRICS_BUFFER capacity emits log.warn with dropped count', async () => {
      _setBullAvailable(true);
      _setBullQueueForTest({ add: vi.fn(async () => undefined), addBulk: vi.fn(async () => []) });

      // Fill metricsBuffer to capacity by persisting metrics for distinct sessions
      const buildMetrics = (sessionId: string): TurnMetrics => ({
        dbSessionId: sessionId,
        tenantId: 'tenant-1',
        tokensIn: 1,
        tokensOut: 1,
        cost: 0.001,
        traceEventCount: 1,
        errorCount: 0,
        handoffCount: 0,
      });

      for (let i = 0; i < MAX_METRICS_BUFFER; i++) {
        await persistTurnMetrics(buildMetrics(`evict-sess-${i}`));
      }
      expect(_getMetricsBufferSize()).toBe(MAX_METRICS_BUFFER);

      // One more entry tips over the cap — eviction fires before inserting the new entry
      await persistTurnMetrics(buildMetrics('evict-sess-overflow'));

      expect(mockLogWarn).toHaveBeenCalledWith(
        'metricsBuffer at capacity — evicted oldest entries',
        expect.objectContaining({
          dropped: Math.floor(MAX_METRICS_BUFFER * 0.1),
          max: MAX_METRICS_BUFFER,
        }),
      );
      // Buffer size should be below the old cap (10% was evicted then one new entry added)
      expect(_getMetricsBufferSize()).toBeLessThan(MAX_METRICS_BUFFER);
    });
  });

  // ── projectId backfill — tenant-scoped query ──────────────────────────────

  describe('backfillMissingProjectIds passes tenantIds to findSessionPersistenceContexts', () => {
    it('calls findSessionPersistenceContexts with the tenantIds from the messages (not bare session IDs)', async () => {
      // Arrange: two messages from different tenants, neither has projectId set
      const batch = {
        messages: [
          {
            dbSessionId: 'sess-tenant-a',
            role: 'assistant',
            content: 'Hello from A',
            channel: 'web_debug',
            tenantId: 'tenant-a',
          },
          {
            dbSessionId: 'sess-tenant-b',
            role: 'assistant',
            content: 'Hello from B',
            channel: 'web_debug',
            tenantId: 'tenant-b',
          },
        ],
        batchId: 'batch-backfill-test',
        enqueuedAt: Date.now(),
      };

      // findSessionPersistenceContexts returns empty — messages will be dropped fail-closed,
      // but what matters is HOW it was called (with tenantIds, not just sessionIds).
      mockFindSessionPersistenceContexts.mockResolvedValueOnce([]);

      await _processBatchForTest(batch as any);

      expect(mockFindSessionPersistenceContexts).toHaveBeenCalledOnce();
      const [sessionIds, tenantIds] = mockFindSessionPersistenceContexts.mock.calls[0];
      expect(sessionIds).toEqual(expect.arrayContaining(['sess-tenant-a', 'sess-tenant-b']));
      // Tenant IDs must be forwarded so the query is tenant-scoped
      expect(tenantIds).toEqual(expect.arrayContaining(['tenant-a', 'tenant-b']));
    });

    it('does not call findSessionPersistenceContexts when all messages already have projectId', async () => {
      const batch = {
        messages: [
          {
            dbSessionId: 'sess-1',
            role: 'assistant',
            content: 'Hello',
            channel: 'web_debug',
            tenantId: 'tenant-a',
            projectId: 'proj-a',
          },
        ],
        batchId: 'batch-no-backfill',
        enqueuedAt: Date.now(),
      };

      await _processBatchForTest(batch as any);

      expect(mockFindSessionPersistenceContexts).not.toHaveBeenCalled();
    });
  });
});
