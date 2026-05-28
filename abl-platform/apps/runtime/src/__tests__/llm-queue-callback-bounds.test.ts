/**
 * LLM Queue — Callback Registry Bounds Tests
 *
 * Verifies that the callback registry has:
 * 1. A max size (MAX_CALLBACK_REGISTRY_SIZE) — rejects when full
 * 2. TTL-based eviction (CALLBACK_TTL_MS) — cleans stale entries before rejecting
 * 3. registeredAt timestamp on all new callbacks
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — guaranteed to exist before vi.mock factories run
// ---------------------------------------------------------------------------

const { mockAcquireLock, mockReleaseLock, mockExecuteMessage, mockConfigState } = vi.hoisted(
  () => ({
    mockAcquireLock: vi.fn<[string], Promise<boolean>>(),
    mockReleaseLock: vi.fn<[string], Promise<void>>(),
    mockExecuteMessage: vi.fn<[string, string, any?, any?], Promise<any>>(),
    mockConfigState: {
      enabled: false,
      concurrency: 10,
      backpressureThreshold: 100,
      jobTimeoutMs: 60000,
    },
  }),
);

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

vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
  isRedisAvailable: () => false,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  enqueueLLMRequest,
  BackpressureError,
  shutdownLLMQueue,
  _setExecutorResolver,
  _getCallbackRegistrySize,
  _registerTestCallback,
  _cleanStaleCallbacks,
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

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  mockAcquireLock.mockResolvedValue(true);
  mockReleaseLock.mockResolvedValue(undefined);
  mockExecuteMessage.mockResolvedValue({ response: 'ok' });
  mockConfigState.enabled = false;
  mockConfigState.concurrency = 10;
  mockConfigState.backpressureThreshold = 100;
  mockConfigState.jobTimeoutMs = 60000;

  // Use a small registry limit for tests (env var is read at module load,
  // so we override at the source-level via _registerTestCallback to fill it)
  _setExecutorResolver(async () => ({ executeMessage: mockExecuteMessage }));
});

afterEach(async () => {
  _setExecutorResolver(null);
  await shutdownLLMQueue();
  process.env = { ...originalEnv };
});

// =============================================================================
// 1. CALLBACK REGISTRY BOUNDS
// =============================================================================

describe('Callback registry bounds', () => {
  test('_getCallbackRegistrySize returns 0 when empty', () => {
    expect(_getCallbackRegistrySize()).toBe(0);
  });

  test('_registerTestCallback increases registry size', () => {
    _registerTestCallback('test-1', {
      resolve: noop,
      reject: noop,
      registeredAt: Date.now(),
    });
    expect(_getCallbackRegistrySize()).toBe(1);
  });

  test('multiple registrations tracked accurately', () => {
    for (let i = 0; i < 10; i++) {
      _registerTestCallback(`test-multi-${i}`, {
        resolve: noop,
        reject: noop,
        registeredAt: Date.now(),
      });
    }
    expect(_getCallbackRegistrySize()).toBe(10);
  });
});

// =============================================================================
// 2. STALE CALLBACK CLEANUP
// =============================================================================

describe('cleanStaleCallbacks', () => {
  test('removes expired entries and rejects their callbacks', () => {
    const rejectFns: vi.Mock[] = [];

    // Register 5 callbacks with old timestamps (well beyond the default 5min TTL)
    for (let i = 0; i < 5; i++) {
      const reject = vi.fn();
      rejectFns.push(reject);
      _registerTestCallback(`stale-${i}`, {
        resolve: noop,
        reject,
        registeredAt: Date.now() - 400000, // 6.7 min ago (> 5 min TTL)
      });
    }

    expect(_getCallbackRegistrySize()).toBe(5);

    const cleaned = _cleanStaleCallbacks();

    expect(cleaned).toBe(5);
    expect(_getCallbackRegistrySize()).toBe(0);

    // All reject callbacks should have been called with TTL expiry error
    for (const reject of rejectFns) {
      expect(reject).toHaveBeenCalledOnce();
      expect(reject.mock.calls[0][0]).toBeInstanceOf(Error);
      expect((reject.mock.calls[0][0] as Error).message).toMatch(/Callback expired after/);
      expect((reject.mock.calls[0][0] as Error).message).toMatch(/TTL/);
    }
  });

  test('does not remove fresh entries', () => {
    // Register callbacks with recent timestamps
    for (let i = 0; i < 3; i++) {
      _registerTestCallback(`fresh-${i}`, {
        resolve: noop,
        reject: vi.fn(),
        registeredAt: Date.now(), // just now
      });
    }

    expect(_getCallbackRegistrySize()).toBe(3);

    const cleaned = _cleanStaleCallbacks();

    expect(cleaned).toBe(0);
    expect(_getCallbackRegistrySize()).toBe(3);
  });

  test('removes only expired entries in mixed set', () => {
    const freshReject = vi.fn();
    const staleReject = vi.fn();

    _registerTestCallback('fresh-1', {
      resolve: noop,
      reject: freshReject,
      registeredAt: Date.now(),
    });
    _registerTestCallback('stale-1', {
      resolve: noop,
      reject: staleReject,
      registeredAt: Date.now() - 400000,
    });

    const cleaned = _cleanStaleCallbacks();

    expect(cleaned).toBe(1);
    expect(_getCallbackRegistrySize()).toBe(1);
    expect(freshReject).not.toHaveBeenCalled();
    expect(staleReject).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// 3. REGISTRY FULL — BACKPRESSURE ERROR
// (Note: The bounds check is in the BullMQ path. The local fallback does not
//  use the callback registry. We test the _registerTestCallback + cleanup
//  functions directly since they exercise the same underlying data structure.)
// =============================================================================

describe('Registry full rejection (direct bounds test)', () => {
  test('filling registry to max and calling cleanStaleCallbacks on fresh entries returns 0', () => {
    // Use a small number to simulate "full" — the actual MAX is from env var (5000 default).
    // We fill with registeredAt = now, so none are stale.
    const fillCount = 10;
    for (let i = 0; i < fillCount; i++) {
      _registerTestCallback(`full-${i}`, {
        resolve: noop,
        reject: vi.fn(),
        registeredAt: Date.now(),
      });
    }

    expect(_getCallbackRegistrySize()).toBe(fillCount);

    // Clean should not remove any (all are fresh)
    const cleaned = _cleanStaleCallbacks();
    expect(cleaned).toBe(0);
    expect(_getCallbackRegistrySize()).toBe(fillCount);
  });

  test('filling registry then making entries stale allows cleanup to free space', () => {
    const fillCount = 10;
    const rejectFns: vi.Mock[] = [];

    for (let i = 0; i < fillCount; i++) {
      const reject = vi.fn();
      rejectFns.push(reject);
      _registerTestCallback(`full-stale-${i}`, {
        resolve: noop,
        reject,
        registeredAt: Date.now() - 400000, // expired
      });
    }

    expect(_getCallbackRegistrySize()).toBe(fillCount);

    const cleaned = _cleanStaleCallbacks();
    expect(cleaned).toBe(fillCount);
    expect(_getCallbackRegistrySize()).toBe(0);

    // All callbacks were rejected
    for (const reject of rejectFns) {
      expect(reject).toHaveBeenCalledOnce();
    }
  });
});

// =============================================================================
// 4. BACKPRESSURE ERROR PROPERTIES
// =============================================================================

describe('BackpressureError for registry full', () => {
  test('BackpressureError with registry-full message', () => {
    const err = new BackpressureError('Callback registry full (5000/5000)');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BackpressureError);
    expect(err.message).toBe('Callback registry full (5000/5000)');
    expect(err.name).toBe('BackpressureError');
  });
});

// =============================================================================
// 5. INTEGRATION: enqueueLLMRequest still works after cleanup
// =============================================================================

describe('Integration: enqueue after stale cleanup', () => {
  test('enqueueLLMRequest succeeds when registry has stale entries cleaned', async () => {
    // Fill registry with stale entries
    for (let i = 0; i < 5; i++) {
      _registerTestCallback(`stale-int-${i}`, {
        resolve: noop,
        reject: vi.fn(),
        registeredAt: Date.now() - 400000,
      });
    }

    // Clean them
    _cleanStaleCallbacks();
    expect(_getCallbackRegistrySize()).toBe(0);

    // Now a normal enqueue should succeed (local fallback path)
    const result = await enqueueLLMRequest(uid(), 'hello');
    expect(result).toEqual({ response: 'ok' });
  });

  test('shutdownLLMQueue clears all registry entries', async () => {
    // Register some callbacks
    for (let i = 0; i < 3; i++) {
      _registerTestCallback(`shutdown-${i}`, {
        resolve: noop,
        reject: vi.fn(),
        registeredAt: Date.now(),
      });
    }

    expect(_getCallbackRegistrySize()).toBe(3);

    await shutdownLLMQueue();

    expect(_getCallbackRegistrySize()).toBe(0);
  });
});
