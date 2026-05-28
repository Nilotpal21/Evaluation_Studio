/**
 * LLM Queue — execOptions Serialization Regression Test
 *
 * BUG: In llm-queue.ts, when building jobData.execOptions for BullMQ,
 * execOption fields can be silently dropped during explicit serialization,
 * meaning distributed BullMQ workers do not receive the full turn context.
 *
 * This test DEMONSTRATES the bug: it will FAIL until the fix is applied.
 * After fixing lines 452-456 in llm-queue.ts to include channelMetadata
 * in the serialized job data, this test should pass.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — guaranteed to exist before vi.mock factories run
// ---------------------------------------------------------------------------

const { mockConfigState, mockQueueAdd, mockQueueGetWaitingCount, mockQueueClose, mockWorkerClose } =
  vi.hoisted(() => ({
    mockConfigState: {
      enabled: true,
      concurrency: 10,
      backpressureThreshold: 100,
      jobTimeoutMs: 60000,
    },
    mockQueueAdd: vi.fn().mockResolvedValue(undefined),
    mockQueueGetWaitingCount: vi.fn().mockResolvedValue(0),
    mockQueueClose: vi.fn().mockResolvedValue(undefined),
    mockWorkerClose: vi.fn().mockResolvedValue(undefined),
  }));

// Mock BullMQ — class-based constructors (matching backpressure-metrics pattern)
vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    close = mockQueueClose;
    add = mockQueueAdd;
    getWaitingCount = mockQueueGetWaitingCount;
  },
  Worker: class MockWorker {
    close = mockWorkerClose;
    on = vi.fn();
    constructor(_name: string, _processor: any, _opts: any) {
      // no-op
    }
  },
}));

// Mock Redis as available so the BullMQ path is taken
const mockRedisDuplicate = (_opts?: any) => ({ disconnect: vi.fn() });
const mockRedisStub = { duplicate: mockRedisDuplicate } as any;
vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: () => mockRedisStub,
  isRedisAvailable: () => true,
  getRedisHandle: () => ({
    client: mockRedisStub,
    isReady: () => true,
    duplicate: mockRedisDuplicate,
    disconnect: async () => {},
  }),
}));

vi.mock('@agent-platform/redis', async () => {
  const actual =
    await vi.importActual<typeof import('@agent-platform/redis')>('@agent-platform/redis');
  return {
    ...actual,
    createBullMQPair: (handle: { duplicate: (opts?: any) => any }) => ({
      queueConnection: handle.duplicate({ maxRetriesPerRequest: null }),
      workerConnection: handle.duplicate({ maxRetriesPerRequest: null }),
      disconnect: () => {},
    }),
  };
});

vi.mock('../config/loader.js', () => ({
  isConfigLoaded: () => true,
  getConfig: () => ({
    llmQueue: {
      enabled: mockConfigState.enabled,
      concurrency: mockConfigState.concurrency,
      backpressureThreshold: mockConfigState.backpressureThreshold,
      jobTimeoutMs: mockConfigState.jobTimeoutMs,
    },
  }),
}));

vi.mock('../services/session/session-service.js', () => ({
  getSessionService: () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    getConfig: () => ({ lockTtlMs: 5000 }),
  }),
}));

vi.mock('@abl/compiler/platform/observability', () => ({
  getCurrentTraceId: () => 'test-trace-id',
  getObservabilityContext: () => null,
  runWithObservabilityContext: vi.fn(),
}));

vi.mock('@agent-platform/shared-observability/tracing', () => ({
  injectTrace: vi.fn(),
  extractTrace: vi.fn(),
}));

vi.mock('../observability/metrics.js', () => ({
  recordBackpressure: vi.fn(),
}));

vi.mock('../services/trace-store.js', () => ({
  getTraceStore: () => ({
    addEvent: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { enqueueLLMRequest, shutdownLLMQueue } from '../services/llm/llm-queue.js';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockQueueGetWaitingCount.mockResolvedValue(0);
});

afterEach(async () => {
  // shutdownLLMQueue rejects pending callbacks — suppress the expected rejection
  await shutdownLLMQueue().catch(() => {
    // Expected: pending enqueue promises are rejected on shutdown
  });
});

// =============================================================================
// REGRESSION: execOptions must survive BullMQ serialization
// =============================================================================

describe('enqueueLLMRequest — channelMetadata serialization (BullMQ path)', () => {
  test('BUG REGRESSION: channelMetadata in execOptions must be included in serialized job data', async () => {
    const sessionId = 'sess-meta-test';
    const message = 'Hello';
    const tenantId = 'tenant-1';
    const channelMetadata = {
      channel: 'web-sdk',
      contentLength: 5,
      hasAttachments: false,
      attachmentCount: 0,
    };
    const execOptions = {
      channelMetadata,
      messageMetadata: {
        locale: 'en-US',
        context: { plan: 'enterprise' },
      },
      attachmentIds: ['att-1'],
      actionEvent: { actionId: 'btn-ok', value: 'confirm' },
    };

    // Fire-and-forget — the promise won't resolve because the
    // worker mock doesn't process jobs, but we only care about the
    // data passed to bullQueue.add().
    // Attach a catch immediately to prevent unhandled rejection on shutdown.
    const enqueuePromise = enqueueLLMRequest(
      sessionId,
      message,
      undefined, // onChunk
      undefined, // onTraceEvent
      tenantId,
      execOptions,
    ).catch(() => {
      // Expected: rejected on shutdown
    });

    // Let the async BullMQ init and add() call complete
    await new Promise((r) => setTimeout(r, 50));

    // Assert: bullQueue.add() was called
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    const [jobName, jobData] = mockQueueAdd.mock.calls[0] as [string, Record<string, unknown>];
    expect(jobName).toBe('llm-request');

    // Verify fields that ARE correctly serialized
    expect(jobData).toMatchObject({
      sessionId,
      message,
      tenantId,
    });
    expect(jobData.execOptions).toBeDefined();

    const serializedExecOptions = jobData.execOptions as Record<string, unknown>;

    // These two fields are explicitly copied and should be present
    expect(serializedExecOptions.attachmentIds).toEqual(['att-1']);
    expect(serializedExecOptions.actionEvent).toEqual({ actionId: 'btn-ok', value: 'confirm' });
    expect(serializedExecOptions.messageMetadata).toEqual({
      locale: 'en-US',
      context: { plan: 'enterprise' },
    });

    expect(serializedExecOptions.channelMetadata).toEqual({
      channel: 'web-sdk',
      contentLength: 5,
      hasAttachments: false,
      attachmentCount: 0,
    });
  });

  test('BUG REGRESSION: channelMetadata should not be lost when it is the only execOption', async () => {
    const sessionId = 'sess-meta-only';
    const message = 'Test message';
    const execOptions = {
      channelMetadata: {
        channel: 'slack',
        contentLength: 12,
        hasAttachments: true,
        attachmentCount: 2,
      },
    };

    const enqueuePromise = enqueueLLMRequest(
      sessionId,
      message,
      undefined,
      undefined,
      'tenant-2',
      execOptions,
    ).catch(() => {
      // Expected: rejected on shutdown
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, jobData] = mockQueueAdd.mock.calls[0] as [string, Record<string, unknown>];
    const serializedExecOptions = jobData.execOptions as Record<string, unknown>;

    expect(serializedExecOptions).toBeDefined();

    expect(serializedExecOptions.channelMetadata).toEqual({
      channel: 'slack',
      contentLength: 12,
      hasAttachments: true,
      attachmentCount: 2,
    });
  });
});
