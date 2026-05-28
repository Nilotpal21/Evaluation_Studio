/**
 * Backpressure OTEL Metrics Tests
 *
 * Verifies that the OTEL counter `llm.queue.backpressure` is incremented
 * when backpressure events occur in the LLM queue:
 * 1. Queue depth exceeds threshold -> reason='queue_depth_exceeded'
 * 2. Callback registry full -> reason='callback_registry_full'
 *
 * Both paths are on the BullMQ branch (Redis available), so we mock
 * Redis + BullMQ to trigger them.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — guaranteed to exist before vi.mock factories run
// ---------------------------------------------------------------------------

const {
  mockAcquireLock,
  mockReleaseLock,
  mockExecuteMessage,
  mockConfigState,
  mockQueueClose,
  mockWorkerClose,
  mockWorkerOn,
  mockQueueAdd,
  mockQueueGetWaitingCount,
  mockRecordBackpressure,
} = vi.hoisted(() => ({
  mockAcquireLock: vi.fn<[string], Promise<boolean>>(),
  mockReleaseLock: vi.fn<[string], Promise<void>>(),
  mockExecuteMessage: vi.fn<[string, string, any?, any?], Promise<any>>(),
  mockConfigState: {
    enabled: true,
    concurrency: 10,
    backpressureThreshold: 5, // Low threshold for testing
    jobTimeoutMs: 60000,
  },
  mockQueueClose: vi.fn().mockResolvedValue(undefined),
  mockWorkerClose: vi.fn().mockResolvedValue(undefined),
  mockWorkerOn: vi.fn(),
  mockQueueAdd: vi.fn().mockResolvedValue(undefined),
  mockQueueGetWaitingCount: vi.fn().mockResolvedValue(0),
  mockRecordBackpressure: vi.fn(),
}));

vi.mock('../services/session/session-service.js', () => ({
  getSessionService: () => ({
    acquireLock: mockAcquireLock,
    releaseLock: mockReleaseLock,
    getConfig: () => ({ lockTtlMs: 5000 }),
  }),
}));

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

// Redis is AVAILABLE — returns a mock client with duplicate()
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

// Mock BullMQ — class constructors so `new Queue(...)` / `new Worker(...)` work
vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    close = mockQueueClose;
    add = mockQueueAdd;
    getWaitingCount = mockQueueGetWaitingCount;
  },
  Worker: class MockWorker {
    close = mockWorkerClose;
    on = mockWorkerOn;
    constructor(_name: string, _processor: any, _opts: any) {
      // no-op
    }
  },
}));

// Mock the metrics module to spy on recordBackpressure.
// Path is relative to this test file (src/__tests__/) -> one level up to src/, then into observability/.
vi.mock('../observability/metrics.js', () => ({
  recordBackpressure: mockRecordBackpressure,
}));

// Mock trace store to avoid side effects
vi.mock('../services/trace-store.js', () => ({
  getTraceStore: () => ({
    addEvent: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  enqueueLLMRequest,
  BackpressureError,
  shutdownLLMQueue,
  _setExecutorResolver,
  _registerTestCallback,
  _getCallbackRegistrySize,
} from '../services/llm/llm-queue.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
function uid(prefix = 'sess'): string {
  return `${prefix}-${++seq}-${Date.now()}`;
}

function noop(): void {
  /* no-op */
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Ensure clean state: shutdown any previous BullMQ to reset bullInitAttempted
  await shutdownLLMQueue();

  vi.clearAllMocks();
  mockAcquireLock.mockResolvedValue(true);
  mockReleaseLock.mockResolvedValue(undefined);
  mockExecuteMessage.mockResolvedValue({ response: 'ok' });

  mockQueueClose.mockReset();
  mockQueueClose.mockResolvedValue(undefined);
  mockQueueAdd.mockReset();
  mockQueueAdd.mockResolvedValue(undefined);
  mockQueueGetWaitingCount.mockReset();
  mockQueueGetWaitingCount.mockResolvedValue(0);
  mockRecordBackpressure.mockReset();

  mockConfigState.enabled = true;
  mockConfigState.concurrency = 10;
  mockConfigState.backpressureThreshold = 5;
  mockConfigState.jobTimeoutMs = 60000;

  _setExecutorResolver(async () => ({ executeMessage: mockExecuteMessage }));
});

afterEach(async () => {
  _setExecutorResolver(null);
  await shutdownLLMQueue();
});

// =============================================================================
// 1. QUEUE DEPTH EXCEEDED — recordBackpressure('queue_depth_exceeded')
// =============================================================================

describe('Queue depth exceeded backpressure metric', () => {
  test('emits backpressure counter with reason queue_depth_exceeded and tenantId', async () => {
    // Simulate BullMQ reporting queue depth above the threshold
    mockQueueGetWaitingCount.mockResolvedValue(10); // threshold is 5

    const sid = uid();
    const tenantId = 'tenant-bp-1';

    await expect(enqueueLLMRequest(sid, 'hello', undefined, undefined, tenantId)).rejects.toThrow(
      BackpressureError,
    );

    expect(mockRecordBackpressure).toHaveBeenCalledOnce();
    expect(mockRecordBackpressure).toHaveBeenCalledWith('queue_depth_exceeded', tenantId);
  });

  test('emits backpressure counter without tenantId when not provided', async () => {
    mockQueueGetWaitingCount.mockResolvedValue(10);

    const sid = uid();

    await expect(enqueueLLMRequest(sid, 'hello')).rejects.toThrow(BackpressureError);

    expect(mockRecordBackpressure).toHaveBeenCalledOnce();
    expect(mockRecordBackpressure).toHaveBeenCalledWith('queue_depth_exceeded', undefined);
  });

  test('does NOT emit backpressure counter when queue depth is at threshold', async () => {
    // Exactly at threshold — not above it (the check is `>`, not `>=`)
    mockQueueGetWaitingCount.mockResolvedValue(5); // threshold is 5

    const sid = uid();

    // This should NOT throw BackpressureError — depth equals but does not exceed threshold.
    // It will return a pending BullMQ promise. Catch the eventual shutdown rejection.
    const promise = enqueueLLMRequest(sid, 'hello', undefined, undefined, 'tenant-ok');
    promise.catch(() => {}); // Suppress unhandled rejection on shutdown cleanup

    expect(mockRecordBackpressure).not.toHaveBeenCalled();
  });

  test('emits backpressure counter when queue depth is exactly threshold + 1', async () => {
    mockQueueGetWaitingCount.mockResolvedValue(6); // threshold is 5

    const sid = uid();
    const tenantId = 'tenant-edge';

    await expect(enqueueLLMRequest(sid, 'hello', undefined, undefined, tenantId)).rejects.toThrow(
      BackpressureError,
    );

    expect(mockRecordBackpressure).toHaveBeenCalledOnce();
    expect(mockRecordBackpressure).toHaveBeenCalledWith('queue_depth_exceeded', tenantId);
  });
});

// =============================================================================
// 2. CALLBACK REGISTRY FULL — recordBackpressure('callback_registry_full')
// =============================================================================

describe('Callback registry full backpressure metric', () => {
  test('emits backpressure counter with reason callback_registry_full and tenantId', async () => {
    // Queue depth is fine (below threshold)
    mockQueueGetWaitingCount.mockResolvedValue(0);

    // Fill the callback registry to its max (default 5000 from env)
    const MAX = 5000; // default MAX_CALLBACK_REGISTRY_SIZE
    const currentSize = _getCallbackRegistrySize();

    // Fill to max with fresh callbacks (not stale — so cleanup won't free any)
    for (let i = currentSize; i < MAX; i++) {
      _registerTestCallback(`fill-${i}`, {
        resolve: noop,
        reject: noop,
        registeredAt: Date.now(), // fresh — won't be cleaned by stale sweep
      });
    }

    expect(_getCallbackRegistrySize()).toBe(MAX);

    const sid = uid();
    const tenantId = 'tenant-reg-full';

    await expect(enqueueLLMRequest(sid, 'hello', undefined, undefined, tenantId)).rejects.toThrow(
      BackpressureError,
    );

    expect(mockRecordBackpressure).toHaveBeenCalledOnce();
    expect(mockRecordBackpressure).toHaveBeenCalledWith('callback_registry_full', tenantId);
  });

  test('emits backpressure counter without tenantId when not provided', async () => {
    mockQueueGetWaitingCount.mockResolvedValue(0);

    const MAX = 5000;
    const currentSize = _getCallbackRegistrySize();
    for (let i = currentSize; i < MAX; i++) {
      _registerTestCallback(`fill-notnnt-${i}`, {
        resolve: noop,
        reject: noop,
        registeredAt: Date.now(),
      });
    }

    const sid = uid();

    await expect(enqueueLLMRequest(sid, 'hello')).rejects.toThrow(BackpressureError);

    expect(mockRecordBackpressure).toHaveBeenCalledOnce();
    expect(mockRecordBackpressure).toHaveBeenCalledWith('callback_registry_full', undefined);
  });

  test('stale cleanup frees space — no backpressure metric emitted', async () => {
    mockQueueGetWaitingCount.mockResolvedValue(0);

    // Fill with STALE callbacks (old registeredAt) so cleanup removes them
    const MAX = 5000;
    const currentSize = _getCallbackRegistrySize();
    for (let i = currentSize; i < MAX; i++) {
      _registerTestCallback(`stale-fill-${i}`, {
        resolve: noop,
        reject: vi.fn(),
        registeredAt: Date.now() - 400000, // well past 5min TTL
      });
    }

    expect(_getCallbackRegistrySize()).toBe(MAX);

    const sid = uid();

    // This will trigger cleanup (stale entries removed), then succeed.
    // The promise is a pending BullMQ job — suppress shutdown rejection.
    const promise = enqueueLLMRequest(sid, 'hello', undefined, undefined, 'tenant-clean');
    promise.catch(() => {}); // Suppress unhandled rejection on shutdown cleanup

    // After cleanup, registry should be almost empty, no backpressure error
    expect(mockRecordBackpressure).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 3. METRIC NOT EMITTED ON NORMAL OPERATION
// =============================================================================

describe('No backpressure metric on normal operation', () => {
  test('successful enqueue does not emit backpressure counter', async () => {
    mockQueueGetWaitingCount.mockResolvedValue(0);

    const sid = uid();
    // Enqueue succeeds (BullMQ path) — returns pending promise for worker.
    // Suppress shutdown rejection.
    const promise = enqueueLLMRequest(sid, 'hello', undefined, undefined, 'tenant-ok');
    promise.catch(() => {}); // Suppress unhandled rejection on shutdown cleanup

    // No backpressure — metric should not be called
    expect(mockRecordBackpressure).not.toHaveBeenCalled();
  });
});
