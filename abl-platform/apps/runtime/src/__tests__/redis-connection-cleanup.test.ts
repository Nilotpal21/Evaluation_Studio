/**
 * Redis Connection Cleanup Tests
 *
 * Verifies that duplicated Redis connections created by initBullMQ() are
 * properly tracked and disconnected during shutdownLLMQueue().
 *
 * The bug: redis.duplicate() is called twice in initBullMQ() (once for the
 * Queue, once for the Worker). On shutdown, only bullQueue.close() and
 * bullWorker.close() were called — the underlying duplicated connections
 * were never disconnected, leaking Redis connections.
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
} = vi.hoisted(() => {
  return {
    mockAcquireLock: vi.fn<[string], Promise<boolean>>(),
    mockReleaseLock: vi.fn<[string], Promise<void>>(),
    mockExecuteMessage: vi.fn<[string, string, any?, any?], Promise<any>>(),
    mockConfigState: {
      enabled: true,
      concurrency: 10,
      backpressureThreshold: 100,
      jobTimeoutMs: 60000,
    },
    mockQueueClose: vi.fn().mockResolvedValue(undefined),
    mockWorkerClose: vi.fn().mockResolvedValue(undefined),
    mockWorkerOn: vi.fn(),
    mockQueueAdd: vi.fn().mockResolvedValue(undefined),
    mockQueueGetWaitingCount: vi.fn().mockResolvedValue(0),
  };
});

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

// Redis is AVAILABLE — returns a mock client with duplicate().
// Each duplicate() call creates a fresh connection object with a disconnect spy.
vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: () => ({
    duplicate: (_opts?: any) => ({
      disconnect: vi.fn(),
    }),
  }),
  isRedisAvailable: () => true,
  getRedisHandle: () => null,
}));

// Mock trace store and OTEL metrics — not relevant to connection cleanup tests
vi.mock('../services/trace-store.js', () => ({
  getTraceStore: () => ({
    addEvent: vi.fn(),
  }),
}));

vi.mock('../observability/metrics.js', () => ({
  recordBackpressure: vi.fn(),
}));

// Mock BullMQ — use proper class constructors so `new Queue(...)` / `new Worker(...)` work
vi.mock('bullmq', () => {
  return {
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
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  enqueueLLMRequest,
  shutdownLLMQueue,
  _setExecutorResolver,
  _getConnections,
} from '../services/llm/llm-queue.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
function uid(prefix = 'sess'): string {
  return `${prefix}-${++seq}-${Date.now()}`;
}

/** Flush microtask queue so pending Promises advance */
function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Ensure clean state: shutdown any previous BullMQ to reset bullInitAttempted
  await shutdownLLMQueue();

  // Reset individual mocks
  mockAcquireLock.mockReset();
  mockAcquireLock.mockResolvedValue(true);
  mockReleaseLock.mockReset();
  mockReleaseLock.mockResolvedValue(undefined);
  mockExecuteMessage.mockReset();
  mockExecuteMessage.mockResolvedValue({ response: 'ok' });

  mockQueueClose.mockReset();
  mockQueueClose.mockResolvedValue(undefined);
  mockQueueAdd.mockReset();
  mockQueueAdd.mockResolvedValue(undefined);
  mockQueueGetWaitingCount.mockReset();
  mockQueueGetWaitingCount.mockResolvedValue(0);
  mockWorkerClose.mockReset();
  mockWorkerClose.mockResolvedValue(undefined);
  mockWorkerOn.mockReset();

  _setExecutorResolver(async () => ({ executeMessage: mockExecuteMessage }));
});

afterEach(async () => {
  _setExecutorResolver(null);
  await shutdownLLMQueue();
});

// =============================================================================
// REDIS CONNECTION CLEANUP
// =============================================================================

describe('Redis connection cleanup in LLM queue', () => {
  test('shutdownLLMQueue disconnects both duplicated Redis connections', async () => {
    // Trigger BullMQ initialization by enqueuing a request.
    const p = enqueueLLMRequest(uid(), 'hello');
    // First call needs extra time for dynamic import('bullmq') module loading
    await tick(200);

    // Verify init created connections (accessible via _getConnections)
    const conns = _getConnections();
    expect(conns.queue).not.toBeNull();
    expect(conns.worker).not.toBeNull();
    const qConn = conns.queue;
    const wConn = conns.worker;

    // Shutdown cleans up
    await shutdownLLMQueue();

    // Verify both duplicated connections had disconnect() called exactly once
    expect(qConn.disconnect).toHaveBeenCalledTimes(1);
    expect(wConn.disconnect).toHaveBeenCalledTimes(1);

    // Verify connection references are nulled out after shutdown
    const after = _getConnections();
    expect(after.queue).toBeNull();
    expect(after.worker).toBeNull();

    // Clean up the rejected promise
    await p.catch(() => {});
  });

  test('shutdown is safe when BullMQ was never initialized (no connections to clean)', async () => {
    // Call shutdown without ever initializing BullMQ (no enqueue call)
    await shutdownLLMQueue();

    // Connection references should remain null
    const conns = _getConnections();
    expect(conns.queue).toBeNull();
    expect(conns.worker).toBeNull();
  });

  test('connections are cleaned up even if BullMQ close() throws', async () => {
    // Trigger BullMQ initialization
    const p = enqueueLLMRequest(uid(), 'test');
    await tick();

    const conns = _getConnections();
    expect(conns.queue).not.toBeNull();
    expect(conns.worker).not.toBeNull();
    const qConn = conns.queue;
    const wConn = conns.worker;

    // Make BullMQ Queue.close() and Worker.close() throw
    mockQueueClose.mockRejectedValue(new Error('Queue close failed'));
    mockWorkerClose.mockRejectedValue(new Error('Worker close failed'));

    // Shutdown should not throw despite close() failures
    await shutdownLLMQueue();

    // Disconnect must still be called on both connections
    expect(qConn.disconnect).toHaveBeenCalledTimes(1);
    expect(wConn.disconnect).toHaveBeenCalledTimes(1);

    // Connection references should be nulled
    const after = _getConnections();
    expect(after.queue).toBeNull();
    expect(after.worker).toBeNull();

    await p.catch(() => {});
  });

  test('re-initialization after shutdown creates fresh connections', async () => {
    // First init cycle: enqueue triggers initBullMQ
    const p1 = enqueueLLMRequest(uid(), 'first');
    await tick();

    const conns1 = _getConnections();
    expect(conns1.queue).not.toBeNull();
    expect(conns1.worker).not.toBeNull();
    const qConn1 = conns1.queue;
    const wConn1 = conns1.worker;

    // Shutdown — cleans up connections
    await shutdownLLMQueue();
    await p1.catch(() => {});

    expect(qConn1.disconnect).toHaveBeenCalledTimes(1);
    expect(wConn1.disconnect).toHaveBeenCalledTimes(1);

    // Second init cycle: enqueue triggers initBullMQ again
    const p2 = enqueueLLMRequest(uid(), 'second');
    await tick();

    // New connections should be created (different references from old ones)
    const conns2 = _getConnections();
    expect(conns2.queue).not.toBeNull();
    expect(conns2.worker).not.toBeNull();
    expect(conns2.queue).not.toBe(qConn1);
    expect(conns2.worker).not.toBe(wConn1);
    const qConn2 = conns2.queue;
    const wConn2 = conns2.worker;

    // Second shutdown should disconnect the new connections
    await shutdownLLMQueue();
    await p2.catch(() => {});

    expect(qConn2.disconnect).toHaveBeenCalledTimes(1);
    expect(wConn2.disconnect).toHaveBeenCalledTimes(1);

    // Old connections should not have been disconnected again
    expect(qConn1.disconnect).toHaveBeenCalledTimes(1);
    expect(wConn1.disconnect).toHaveBeenCalledTimes(1);
  });

  test('disconnect errors are swallowed (best-effort cleanup)', async () => {
    // Trigger init
    const p = enqueueLLMRequest(uid(), 'hello');
    await tick();

    const conns = _getConnections();
    expect(conns.queue).not.toBeNull();
    expect(conns.worker).not.toBeNull();
    const qConn = conns.queue;
    const wConn = conns.worker;

    // Make disconnect() throw on both connections
    qConn.disconnect.mockImplementation(() => {
      throw new Error('disconnect failed');
    });
    wConn.disconnect.mockImplementation(() => {
      throw new Error('disconnect failed');
    });

    // Shutdown should not throw despite disconnect() failures
    await expect(shutdownLLMQueue()).resolves.not.toThrow();

    // Connection references should still be nulled despite errors
    const after = _getConnections();
    expect(after.queue).toBeNull();
    expect(after.worker).toBeNull();

    await p.catch(() => {});
  });

  test('connections are tracked on the module and accessible via _getConnections()', async () => {
    // Before init, connections should be null
    const before = _getConnections();
    expect(before.queue).toBeNull();
    expect(before.worker).toBeNull();

    // Trigger init
    const p = enqueueLLMRequest(uid(), 'hello');
    await tick();

    // After init, connections should be non-null mock objects with disconnect
    const after = _getConnections();
    expect(after.queue).not.toBeNull();
    expect(after.worker).not.toBeNull();
    expect(after.queue.disconnect).toBeDefined();
    expect(after.worker.disconnect).toBeDefined();

    await shutdownLLMQueue();
    await p.catch(() => {});
  });
});
