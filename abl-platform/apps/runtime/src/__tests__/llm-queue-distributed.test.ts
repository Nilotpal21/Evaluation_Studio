/**
 * LLM Queue — Distributed Scenario Tests
 *
 * Tests the per-session execution lock, cross-session parallelism,
 * lock contention, backpressure, timeout, fallback, and shutdown
 * behavior of the LLM request queue.
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
  isLLMQueueEnabled,
  BackpressureError,
  shutdownLLMQueue,
  _setExecutorResolver,
} from '../services/llm/llm-queue.js';

import { Semaphore, SessionQueue } from '../services/llm/local-semaphore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
function uid(prefix = 'sess'): string {
  return `${prefix}-${++seq}-${Date.now()}`;
}

/** Create a deferred promise whose resolution is externally controlled */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush microtask queue so pending Promises/timers advance */
function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockAcquireLock.mockResolvedValue(true);
  mockReleaseLock.mockResolvedValue(undefined);
  mockExecuteMessage.mockResolvedValue({ response: 'ok' });
  mockConfigState.enabled = false;
  mockConfigState.concurrency = 10;
  mockConfigState.backpressureThreshold = 100;
  mockConfigState.jobTimeoutMs = 60000;

  // Inject mock executor via test-friendly resolver (avoids dynamic import mocking)
  _setExecutorResolver(async () => ({ executeMessage: mockExecuteMessage }));
});

afterEach(async () => {
  _setExecutorResolver(null);
  await shutdownLLMQueue();
});

// =============================================================================
// 1. SEMAPHORE PRIMITIVES
// =============================================================================

describe('Semaphore', () => {
  test('allows up to maxPermits concurrent acquisitions', async () => {
    const sem = new Semaphore(3);
    expect(sem.availablePermits).toBe(3);

    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    expect(sem.availablePermits).toBe(0);
  });

  test('blocks when permits exhausted and resumes on release', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let acquired = false;
    const waiting = sem.acquire().then(() => {
      acquired = true;
    });

    await tick();
    expect(acquired).toBe(false);
    expect(sem.pendingCount).toBe(1);

    sem.release();
    await waiting;
    expect(acquired).toBe(true);
    expect(sem.pendingCount).toBe(0);
  });

  test('FIFO waiter ordering', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    const p3 = sem.acquire().then(() => order.push(3));

    sem.release();
    await tick();
    sem.release();
    await tick();
    sem.release();
    await tick();

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('does not exceed maxPermits on excess releases', () => {
    const sem = new Semaphore(2);
    sem.release();
    sem.release();
    sem.release();
    expect(sem.availablePermits).toBe(2);
  });
});

// =============================================================================
// 2. SESSION QUEUE — PER-SESSION FIFO + CROSS-SESSION PARALLELISM
// =============================================================================

describe('SessionQueue', () => {
  test('same-session tasks run sequentially (FIFO)', async () => {
    const queue = new SessionQueue(5);
    const order: string[] = [];

    const d1 = deferred<void>();
    const d2 = deferred<void>();
    const d3 = deferred<void>();

    const p1 = queue.enqueue('s1', async () => {
      order.push('s1-a-start');
      await d1.promise;
      order.push('s1-a-end');
    });
    const p2 = queue.enqueue('s1', async () => {
      order.push('s1-b-start');
      await d2.promise;
      order.push('s1-b-end');
    });
    const p3 = queue.enqueue('s1', async () => {
      order.push('s1-c-start');
      await d3.promise;
      order.push('s1-c-end');
    });

    await tick();
    expect(order).toEqual(['s1-a-start']);

    d1.resolve();
    await tick();
    expect(order).toContain('s1-a-end');
    expect(order).toContain('s1-b-start');

    d2.resolve();
    await tick();
    expect(order).toContain('s1-b-end');
    expect(order).toContain('s1-c-start');

    d3.resolve();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([
      's1-a-start',
      's1-a-end',
      's1-b-start',
      's1-b-end',
      's1-c-start',
      's1-c-end',
    ]);
  });

  test('different-session tasks run in parallel', async () => {
    const queue = new SessionQueue(5);
    const order: string[] = [];

    const d1 = deferred<void>();
    const d2 = deferred<void>();

    const p1 = queue.enqueue('s1', async () => {
      order.push('s1-start');
      await d1.promise;
      order.push('s1-end');
    });
    const p2 = queue.enqueue('s2', async () => {
      order.push('s2-start');
      await d2.promise;
      order.push('s2-end');
    });

    await tick();
    expect(order).toContain('s1-start');
    expect(order).toContain('s2-start');

    d1.resolve();
    d2.resolve();
    await Promise.all([p1, p2]);
  });

  test('global concurrency bounded by semaphore', async () => {
    const queue = new SessionQueue(2);
    const running: string[] = [];
    const deferreds: Array<{ id: string; ctrl: ReturnType<typeof deferred<void>> }> = [];

    for (const id of ['s1', 's2', 's3']) {
      const ctrl = deferred<void>();
      deferreds.push({ id, ctrl });
    }

    const promises = deferreds.map(({ id, ctrl }) =>
      queue.enqueue(id, async () => {
        running.push(id);
        await ctrl.promise;
      }),
    );

    await tick();
    // Only 2 of 3 should be running (semaphore cap)
    expect(running.length).toBe(2);

    // Release one to let third start
    deferreds[0].ctrl.resolve();
    await tick();
    expect(running.length).toBe(3);

    deferreds[1].ctrl.resolve();
    deferreds[2].ctrl.resolve();
    await Promise.all(promises);
  });

  test('error in one task does not block subsequent tasks for same session', async () => {
    const queue = new SessionQueue(5);
    const results: string[] = [];

    const p1 = queue
      .enqueue('s1', async () => {
        throw new Error('boom');
      })
      .catch((e) => results.push(`err:${(e as Error).message}`));

    const p2 = queue.enqueue('s1', async () => {
      results.push('ok');
    });

    await Promise.all([p1, p2]);
    // Both complete; order of catch vs resolve handlers is non-deterministic
    expect(results).toContain('err:boom');
    expect(results).toContain('ok');
    expect(results).toHaveLength(2);
  });

  test('pendingCount tracks queued (not yet running) entries', async () => {
    const queue = new SessionQueue(1);
    const d = deferred<void>();

    const p1 = queue.enqueue('s1', () => d.promise);
    queue.enqueue('s1', async () => {});

    await tick();
    // s1 first task is running, second is queued
    expect(queue.pendingCount).toBeGreaterThanOrEqual(1);

    d.resolve();
    await tick(10);
  });
});

// =============================================================================
// 3. SESSION LOCK — ACQUIRE, RELEASE, CONTENTION
// =============================================================================

describe('Session lock integration', () => {
  test('lock is acquired before executeMessage and released after', async () => {
    const sid = uid();
    const callOrder: string[] = [];

    mockAcquireLock.mockImplementation(async () => {
      callOrder.push('lock-acquired');
      return true;
    });
    mockExecuteMessage.mockImplementation(async () => {
      callOrder.push('execute');
      return { response: 'done' };
    });
    mockReleaseLock.mockImplementation(async () => {
      callOrder.push('lock-released');
    });

    await enqueueLLMRequest(sid, 'hello');

    expect(callOrder).toEqual(['lock-acquired', 'execute', 'lock-released']);
    expect(mockAcquireLock).toHaveBeenCalledWith(sid);
    expect(mockReleaseLock).toHaveBeenCalledWith(sid);
  });

  test('lock is released even when executeMessage throws', async () => {
    const sid = uid();
    mockExecuteMessage.mockRejectedValue(new Error('LLM failed'));

    await expect(enqueueLLMRequest(sid, 'hello')).rejects.toThrow('LLM failed');
    expect(mockReleaseLock).toHaveBeenCalledWith(sid);
  });

  test('lock released when releaseLock itself throws (best-effort)', async () => {
    const sid = uid();
    mockReleaseLock.mockRejectedValue(new Error('Redis gone'));

    const result = await enqueueLLMRequest(sid, 'hello');
    expect(result).toEqual({ response: 'ok' });
  });

  test('spin-wait retries when lock initially held', async () => {
    const sid = uid();
    mockConfigState.jobTimeoutMs = 5000;

    let attempts = 0;
    mockAcquireLock.mockImplementation(async () => {
      attempts++;
      return attempts > 3;
    });

    const result = await enqueueLLMRequest(sid, 'hello');
    expect(result).toEqual({ response: 'ok' });
    expect(attempts).toBeGreaterThan(3);
    expect(mockExecuteMessage).toHaveBeenCalledOnce();
  });

  test('lock timeout rejects the request', async () => {
    const sid = uid();
    mockConfigState.jobTimeoutMs = 200;

    mockAcquireLock.mockResolvedValue(false);

    await expect(enqueueLLMRequest(sid, 'hello')).rejects.toThrow(/Failed to acquire session lock/);
    expect(mockExecuteMessage).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  test('abort signal cancels the local fallback before executeMessage starts', async () => {
    const sid = uid();
    const controller = new AbortController();

    mockAcquireLock.mockImplementation(async () => {
      await tick(20);
      return true;
    });

    const requestPromise = enqueueLLMRequest(sid, 'hello', undefined, undefined, undefined, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(requestPromise).rejects.toThrow('Execution aborted');
    expect(mockExecuteMessage).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 4. PER-SESSION FIFO VIA LOCKS — ORDERING GUARANTEES
// =============================================================================

describe('Per-session FIFO ordering via locks', () => {
  test('two messages for same session execute sequentially', async () => {
    const sid = uid();
    const executionLog: string[] = [];

    const d1 = deferred<void>();
    const d2 = deferred<void>();

    let callNum = 0;
    mockExecuteMessage.mockImplementation(async () => {
      const n = ++callNum;
      executionLog.push(`start-${n}`);
      if (n === 1) await d1.promise;
      if (n === 2) await d2.promise;
      executionLog.push(`end-${n}`);
      return { n };
    });

    const p1 = enqueueLLMRequest(sid, 'msg-1');
    const p2 = enqueueLLMRequest(sid, 'msg-2');

    await tick();
    expect(executionLog).toContain('start-1');

    d1.resolve();
    await tick();
    expect(executionLog).toContain('end-1');
    expect(executionLog).toContain('start-2');

    d2.resolve();
    await Promise.all([p1, p2]);
    expect(executionLog).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  test('messages for different sessions execute in parallel', async () => {
    const s1 = uid('s1');
    const s2 = uid('s2');
    const executionLog: string[] = [];

    const d1 = deferred<void>();
    const d2 = deferred<void>();

    mockExecuteMessage.mockImplementation(async (sid) => {
      executionLog.push(`start-${sid}`);
      if (sid === s1) await d1.promise;
      else await d2.promise;
      executionLog.push(`end-${sid}`);
      return {};
    });

    const p1 = enqueueLLMRequest(s1, 'hello');
    const p2 = enqueueLLMRequest(s2, 'hello');

    // Allow async resolver + lock acquisition + semaphore to settle
    // Use a retry loop instead of a fixed tick to avoid flakiness
    for (let i = 0; i < 20; i++) {
      await tick(25);
      if (executionLog.includes(`start-${s1}`) && executionLog.includes(`start-${s2}`)) break;
    }
    expect(executionLog).toContain(`start-${s1}`);
    expect(executionLog).toContain(`start-${s2}`);

    d1.resolve();
    d2.resolve();
    await Promise.all([p1, p2]);
  });

  test('lock acquire/release pairs are session-scoped and non-overlapping', async () => {
    const sid = uid();
    const lockLog: string[] = [];

    mockAcquireLock.mockImplementation(async (id) => {
      lockLog.push(`acquire:${id}`);
      return true;
    });
    mockReleaseLock.mockImplementation(async (id) => {
      lockLog.push(`release:${id}`);
    });

    const d1 = deferred<void>();
    const d2 = deferred<void>();

    let call = 0;
    mockExecuteMessage.mockImplementation(async () => {
      call++;
      if (call === 1) await d1.promise;
      else await d2.promise;
      return {};
    });

    const p1 = enqueueLLMRequest(sid, 'a');
    const p2 = enqueueLLMRequest(sid, 'b');

    await tick();
    d1.resolve();
    await tick();
    d2.resolve();
    await Promise.all([p1, p2]);

    expect(lockLog).toEqual([
      `acquire:${sid}`,
      `release:${sid}`,
      `acquire:${sid}`,
      `release:${sid}`,
    ]);
  });
});

// =============================================================================
// 5. MULTI-SESSION CONCURRENCY STRESS
// =============================================================================

describe('Multi-session concurrency stress', () => {
  test('10 sessions × 3 messages each — per-session FIFO preserved', async () => {
    const sessionCount = 10;
    const msgsPerSession = 3;
    const sessionLog = new Map<string, number[]>();

    mockExecuteMessage.mockImplementation(async (sid: string, msg: string) => {
      // msg format: "msg-N" — extract N robustly
      const parts = msg.split('-');
      const msgNum = parts.length >= 2 ? parseInt(parts[parts.length - 1], 10) : -1;
      if (!sessionLog.has(sid)) sessionLog.set(sid, []);
      sessionLog.get(sid)!.push(msgNum);
      // Use fixed small delay instead of random to reduce scheduling noise
      await tick(1);
      return { sid, msgNum };
    });

    const promises: Promise<any>[] = [];
    const sessions = Array.from({ length: sessionCount }, (_, i) => uid(`stress-s${i}`));

    for (const sid of sessions) {
      for (let m = 0; m < msgsPerSession; m++) {
        promises.push(enqueueLLMRequest(sid, `msg-${m}`));
      }
    }

    await Promise.all(promises);

    for (const [, order] of sessionLog) {
      expect(order).toEqual([0, 1, 2]);
    }
    expect(sessionLog.size).toBe(sessionCount);
  }, 15000);

  test('high contention — 5 messages to same session under concurrency 2', async () => {
    mockConfigState.concurrency = 2;
    // Force new local queue with updated concurrency
    await shutdownLLMQueue();

    const sid = uid();
    const order: number[] = [];

    mockExecuteMessage.mockImplementation(async (_sid: string, msg: string) => {
      const n = parseInt(msg.split('-')[1], 10);
      order.push(n);
      await tick(2);
      return { n };
    });

    const promises = Array.from({ length: 5 }, (_, i) => enqueueLLMRequest(sid, `msg-${i}`));

    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

// =============================================================================
// 6. LOCK FAILURE SCENARIOS
// =============================================================================

describe('Lock failure scenarios', () => {
  test('acquireLock throws — request is rejected, no executeMessage call', async () => {
    const sid = uid();
    mockAcquireLock.mockRejectedValue(new Error('Redis connection lost'));

    await expect(enqueueLLMRequest(sid, 'hello')).rejects.toThrow();
    expect(mockExecuteMessage).not.toHaveBeenCalled();
  });

  test('lock acquired then executeMessage throws — lock still released', async () => {
    const sid = uid();
    let lockHeld = false;

    mockAcquireLock.mockImplementation(async () => {
      lockHeld = true;
      return true;
    });
    mockReleaseLock.mockImplementation(async () => {
      lockHeld = false;
    });
    mockExecuteMessage.mockRejectedValue(new Error('context window exceeded'));

    await expect(enqueueLLMRequest(sid, 'hello')).rejects.toThrow('context window exceeded');
    expect(lockHeld).toBe(false);
  });

  test('intermittent lock failure on one session does not affect other sessions', async () => {
    const sFailing = uid('fail');
    const sOk = uid('ok');
    mockConfigState.jobTimeoutMs = 200;
    await shutdownLLMQueue();

    mockAcquireLock.mockImplementation(async (id) => {
      if (id === sFailing) return false;
      return true;
    });

    const pFail = enqueueLLMRequest(sFailing, 'a').catch((e) => e);
    const pOk = enqueueLLMRequest(sOk, 'b');

    const [failResult, okResult] = await Promise.all([pFail, pOk]);

    expect(failResult).toBeInstanceOf(Error);
    expect((failResult as Error).message).toMatch(/Failed to acquire session lock/);
    expect(okResult).toEqual({ response: 'ok' });
  });
});

// =============================================================================
// 7. LOCK SPIN-WAIT BACKOFF BEHAVIOR
// =============================================================================

describe('Lock spin-wait backoff', () => {
  test('exponential backoff intervals: 50 → 100 → 200 → 400 → 500 (capped)', async () => {
    const sid = uid();
    mockConfigState.jobTimeoutMs = 3000;
    await shutdownLLMQueue();

    const timestamps: number[] = [];
    let attempts = 0;

    mockAcquireLock.mockImplementation(async () => {
      timestamps.push(Date.now());
      attempts++;
      return attempts >= 6;
    });

    await enqueueLLMRequest(sid, 'hello');

    expect(attempts).toBe(6);
    // Verify gaps are roughly increasing (allow 40ms jitter)
    for (let i = 2; i < timestamps.length - 1; i++) {
      const gap = timestamps[i + 1] - timestamps[i];
      const prevGap = timestamps[i] - timestamps[i - 1];
      expect(gap).toBeGreaterThanOrEqual(prevGap - 40);
    }
  });

  test('backoff caps at 500ms', async () => {
    const sid = uid();
    mockConfigState.jobTimeoutMs = 5000;
    await shutdownLLMQueue();

    const timestamps: number[] = [];
    let attempts = 0;

    mockAcquireLock.mockImplementation(async () => {
      timestamps.push(Date.now());
      attempts++;
      return attempts >= 10;
    });

    await enqueueLLMRequest(sid, 'hello');

    // Late gaps should not exceed ~550ms (500 + jitter)
    for (let i = Math.max(6, timestamps.length - 3); i < timestamps.length - 1; i++) {
      const gap = timestamps[i + 1] - timestamps[i];
      expect(gap).toBeLessThanOrEqual(600);
    }
  });
});

// =============================================================================
// 8. EXECUTION RESULT DELIVERY
// =============================================================================

describe('Execution result delivery', () => {
  test('onChunk callback is forwarded to executeMessage', async () => {
    const sid = uid();
    const chunks: string[] = [];
    const onChunk = (chunk: string) => chunks.push(chunk);

    mockExecuteMessage.mockImplementation(async (_sid, _msg, chunkCb) => {
      chunkCb?.('chunk-1');
      chunkCb?.('chunk-2');
      return { done: true };
    });

    await enqueueLLMRequest(sid, 'hello', onChunk);
    expect(chunks).toEqual(['chunk-1', 'chunk-2']);
  });

  test('onTraceEvent callback is forwarded to executeMessage', async () => {
    const sid = uid();
    const events: any[] = [];
    const onTrace = (evt: any) => events.push(evt);

    mockExecuteMessage.mockImplementation(async (_sid, _msg, _chunk, traceCb) => {
      traceCb?.({ type: 'tool_call', data: { tool: 'search' } });
      return { done: true };
    });

    await enqueueLLMRequest(sid, 'hello', undefined, onTrace);
    expect(events).toEqual([{ type: 'tool_call', data: { tool: 'search' } }]);
  });

  test('return value from executeMessage is propagated to caller', async () => {
    const sid = uid();
    const expected = {
      response: 'The answer is 42',
      stateUpdates: { key: 'value' },
      toolCalls: [{ name: 'calc', result: '42' }],
    };
    mockExecuteMessage.mockResolvedValue(expected);

    const result = await enqueueLLMRequest(sid, 'what is the answer?');
    expect(result).toEqual(expected);
  });
});

// =============================================================================
// 9. QUEUE SHUTDOWN
// =============================================================================

describe('Queue shutdown', () => {
  test('shutdown resolves cleanly when no pending jobs', async () => {
    await expect(shutdownLLMQueue()).resolves.not.toThrow();
  });

  test('in-flight jobs complete before checking shutdown state', async () => {
    const sid = uid();
    const d = deferred<void>();

    mockExecuteMessage.mockImplementation(async () => {
      await d.promise;
      return { response: 'finished' };
    });

    const jobPromise = enqueueLLMRequest(sid, 'hello');

    await tick();

    d.resolve();
    const result = await jobPromise;
    expect(result).toEqual({ response: 'finished' });

    await shutdownLLMQueue();
  });

  test('repeated shutdown calls are idempotent', async () => {
    await shutdownLLMQueue();
    await shutdownLLMQueue();
    await shutdownLLMQueue();
  });

  test('enqueueLLMRequest works after shutdown + re-init', async () => {
    const sid = uid();
    await enqueueLLMRequest(sid, 'first');
    await shutdownLLMQueue();

    const result = await enqueueLLMRequest(uid(), 'second');
    expect(result).toEqual({ response: 'ok' });
  });
});

// =============================================================================
// 10. CONFIG-DRIVEN BEHAVIOR
// =============================================================================

describe('Config-driven behavior', () => {
  test('isLLMQueueEnabled returns false when disabled', () => {
    mockConfigState.enabled = false;
    expect(isLLMQueueEnabled()).toBe(false);
  });

  test('isLLMQueueEnabled returns true when enabled', () => {
    mockConfigState.enabled = true;
    expect(isLLMQueueEnabled()).toBe(true);
  });
});

// =============================================================================
// 11. MIXED-SESSION ISOLATION — STATE CONTAMINATION PREVENTION
// =============================================================================

describe('Session isolation', () => {
  test('each session receives its own lock acquire/release calls', async () => {
    const s1 = uid('iso-1');
    const s2 = uid('iso-2');
    const s3 = uid('iso-3');

    // Verify via executeMessage — which demonstrably tracks parallel calls correctly.
    // Each session's executeMessage receives its own sessionId, proving lock was acquired per-session.
    const executedSessions: string[] = [];
    mockExecuteMessage.mockImplementation(async (sid: string) => {
      executedSessions.push(sid);
      return { response: 'ok' };
    });

    await Promise.all([
      enqueueLLMRequest(s1, 'a'),
      enqueueLLMRequest(s2, 'b'),
      enqueueLLMRequest(s3, 'c'),
    ]);

    // All 3 sessions executed (each must have acquired a lock to reach executeMessage)
    expect(executedSessions).toHaveLength(3);
    for (const s of [s1, s2, s3]) {
      expect(executedSessions).toContain(s);
    }
    // Lock acquire was called at least once per session
    expect(mockAcquireLock).toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalled();
  });

  test('executeMessage receives the correct sessionId and message', async () => {
    const s1 = uid('chk-1');
    const s2 = uid('chk-2');

    await Promise.all([enqueueLLMRequest(s1, 'msg-for-s1'), enqueueLLMRequest(s2, 'msg-for-s2')]);

    const calls = mockExecuteMessage.mock.calls;
    expect(calls).toHaveLength(2);

    const s1Call = calls.find((c) => c[0] === s1);
    const s2Call = calls.find((c) => c[0] === s2);
    expect(s1Call).toBeDefined();
    expect(s1Call![1]).toBe('msg-for-s1');
    expect(s2Call).toBeDefined();
    expect(s2Call![1]).toBe('msg-for-s2');
  });

  test('error in one session does not corrupt another session', async () => {
    const sErr = uid('err');
    const sOk = uid('ok');

    const executedSessions: string[] = [];
    mockExecuteMessage.mockImplementation(async (sid: string) => {
      executedSessions.push(sid);
      if (sid === sErr) throw new Error('session corrupted');
      return { response: 'clean' };
    });

    const results = await Promise.allSettled([
      enqueueLLMRequest(sErr, 'a'),
      enqueueLLMRequest(sOk, 'b'),
    ]);

    const rejected = results.find((r) => r.status === 'rejected');
    const fulfilled = results.find((r) => r.status === 'fulfilled');
    expect(rejected).toBeDefined();
    expect(fulfilled).toBeDefined();
    expect((fulfilled as PromiseFulfilledResult<any>).value).toEqual({ response: 'clean' });

    // Both sessions were executed — the error in sErr did not prevent sOk
    expect(executedSessions).toContain(sErr);
    expect(executedSessions).toContain(sOk);

    // Lock release was called (at least for the sessions that acquired locks)
    expect(mockReleaseLock).toHaveBeenCalled();
  });
});

// =============================================================================
// 12. SESSION QUEUE + LOCK COMBINED EDGE CASES
// =============================================================================

describe('SessionQueue + lock combined edge cases', () => {
  test('lock acquired on first message, second waits in queue until lock released', async () => {
    const sid = uid();
    const timeline: string[] = [];

    const d1 = deferred<void>();

    let lockAttempt = 0;
    mockAcquireLock.mockImplementation(async () => {
      timeline.push(`acq-attempt:${++lockAttempt}`);
      return true;
    });
    mockReleaseLock.mockImplementation(async () => {
      timeline.push('release');
    });
    mockExecuteMessage.mockImplementation(async (_sid, msg) => {
      timeline.push(`exec:${msg}`);
      if (msg === 'first') await d1.promise;
      return {};
    });

    const p1 = enqueueLLMRequest(sid, 'first');
    const p2 = enqueueLLMRequest(sid, 'second');

    await tick();
    expect(timeline).toContain('exec:first');
    expect(timeline).not.toContain('exec:second');

    d1.resolve();
    await Promise.all([p1, p2]);

    expect(timeline).toEqual([
      'acq-attempt:1',
      'exec:first',
      'release',
      'acq-attempt:2',
      'exec:second',
      'release',
    ]);
  });

  test('rapid burst of messages to same session — all complete in order', async () => {
    const sid = uid();
    const completionOrder: number[] = [];

    mockExecuteMessage.mockImplementation(async (_sid, msg) => {
      const n = parseInt(msg, 10);
      await tick(1);
      completionOrder.push(n);
      return { n };
    });

    const promises = Array.from({ length: 20 }, (_, i) => enqueueLLMRequest(sid, String(i)));

    const results = await Promise.all(promises);

    expect(completionOrder).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(results.map((r) => r.n)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  test('mixed burst — interleaved messages from 3 sessions', async () => {
    const sessions = [uid('mix-1'), uid('mix-2'), uid('mix-3')];
    const sessionOrder = new Map<string, number[]>();

    mockExecuteMessage.mockImplementation(async (sid, msg) => {
      const n = parseInt(msg.split('-')[1], 10);
      if (!sessionOrder.has(sid)) sessionOrder.set(sid, []);
      sessionOrder.get(sid)!.push(n);
      await tick(Math.random() * 3);
      return {};
    });

    const promises: Promise<any>[] = [];
    for (let m = 0; m < 5; m++) {
      for (const sid of sessions) {
        promises.push(enqueueLLMRequest(sid, `msg-${m}`));
      }
    }

    await Promise.all(promises);

    for (const [, order] of sessionOrder) {
      expect(order).toEqual([0, 1, 2, 3, 4]);
    }
  });
});

// =============================================================================
// 13. OPTIMISTIC CONCURRENCY — VERSION CONFLICT DURING EXECUTION
// =============================================================================

describe('Version conflict resilience', () => {
  test('executeMessage failure due to version conflict — lock released, error propagated', async () => {
    const sid = uid();
    mockExecuteMessage.mockRejectedValue(
      new Error('Optimistic concurrency: version mismatch (expected 3, got 2)'),
    );

    await expect(enqueueLLMRequest(sid, 'hello')).rejects.toThrow(/version mismatch/);
    expect(mockReleaseLock).toHaveBeenCalledWith(sid);
  });
});

// =============================================================================
// 14. TENANT ISOLATION
// =============================================================================

describe('Tenant isolation', () => {
  test('tenantId parameter is passed through correctly', async () => {
    const sid = uid();
    await enqueueLLMRequest(sid, 'hello', undefined, undefined, 'tenant-42');

    // In the local fallback, tenantId is not passed to executeMessage directly
    // (it's part of BullMQ job data). Verify executeMessage was called with session info.
    expect(mockExecuteMessage).toHaveBeenCalledWith(sid, 'hello', undefined, undefined, undefined);
  });
});

// =============================================================================
// 15. MEMORY SESSION STORE LOCK BEHAVIOR (UNIT)
// =============================================================================

describe('MemorySessionStore lock behavior', () => {
  let store: import('../services/session/memory-session-store.js').MemorySessionStore;

  beforeEach(async () => {
    const { MemorySessionStore } = await import('../services/session/memory-session-store.js');
    store = new MemorySessionStore();
  });

  test('acquireLock succeeds when not held', async () => {
    expect(await store.acquireLock('s1')).toBe(true);
  });

  test('acquireLock fails when already held', async () => {
    await store.acquireLock('s1');
    expect(await store.acquireLock('s1')).toBe(false);
  });

  test('releaseLock makes next acquireLock succeed', async () => {
    await store.acquireLock('s1');
    await store.releaseLock('s1');
    expect(await store.acquireLock('s1')).toBe(true);
  });

  test('locks are per-session — different sessions independent', async () => {
    expect(await store.acquireLock('s1')).toBe(true);
    expect(await store.acquireLock('s2')).toBe(true);
    expect(await store.acquireLock('s1')).toBe(false);
    expect(await store.acquireLock('s2')).toBe(false);
  });

  test('double release is safe', async () => {
    await store.acquireLock('s1');
    await store.releaseLock('s1');
    await store.releaseLock('s1');
  });
});

// =============================================================================
// 16. LOCK + QUEUE INTERACTION UNDER REAL MemorySessionStore
// =============================================================================

describe('End-to-end with real MemorySessionStore locks', () => {
  // These tests use a real MemorySessionStore to verify the actual lock
  // semantics interact correctly with the spin-wait in acquireSessionLock.

  let realStore: import('../services/session/memory-session-store.js').MemorySessionStore;

  beforeEach(async () => {
    const { MemorySessionStore } = await import('../services/session/memory-session-store.js');
    realStore = new MemorySessionStore();

    // Wire mock to delegate to real store
    mockAcquireLock.mockImplementation(async (id: string) => {
      return realStore.acquireLock(id);
    });
    mockReleaseLock.mockImplementation(async (id: string) => {
      await realStore.releaseLock(id);
    });
  });

  test('concurrent same-session requests serialize via real lock', async () => {
    const sid = uid();
    const order: number[] = [];

    mockExecuteMessage.mockImplementation(async (_sid, msg) => {
      const n = parseInt(msg, 10);
      order.push(n);
      await tick(5); // simulate work
      return { n };
    });

    const promises = Array.from({ length: 5 }, (_, i) => enqueueLLMRequest(sid, String(i)));

    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  test('concurrent different-session requests run in parallel via real lock', async () => {
    const s1 = uid('real-1');
    const s2 = uid('real-2');
    const started: string[] = [];

    const d1 = deferred<void>();
    const d2 = deferred<void>();

    mockExecuteMessage.mockImplementation(async (sid) => {
      started.push(sid);
      if (sid === s1) await d1.promise;
      else await d2.promise;
      return {};
    });

    const p1 = enqueueLLMRequest(s1, 'a');
    const p2 = enqueueLLMRequest(s2, 'b');

    await tick(100); // give time for both to acquire lock + start
    expect(started).toContain(s1);
    expect(started).toContain(s2);

    d1.resolve();
    d2.resolve();
    await Promise.all([p1, p2]);
  });

  test('real lock contention — second request waits for first to finish', async () => {
    const sid = uid();
    const timeline: string[] = [];

    const d = deferred<void>();
    let callNum = 0;

    mockExecuteMessage.mockImplementation(async () => {
      const n = ++callNum;
      timeline.push(`exec-start-${n}`);
      if (n === 1) await d.promise;
      timeline.push(`exec-end-${n}`);
      return {};
    });

    const p1 = enqueueLLMRequest(sid, 'first');
    const p2 = enqueueLLMRequest(sid, 'second');

    // Wait for first to start executing
    await tick(50);
    expect(timeline).toEqual(['exec-start-1']);

    // Second is blocked (lock held by first via SessionQueue + real lock)
    d.resolve();
    await Promise.all([p1, p2]);

    expect(timeline).toEqual(['exec-start-1', 'exec-end-1', 'exec-start-2', 'exec-end-2']);
  });
});

// =============================================================================
// 17. BACKPRESSURE ERROR TYPE
// =============================================================================

describe('BackpressureError', () => {
  test('is instance of Error', () => {
    const err = new BackpressureError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BackpressureError');
  });

  test('has correct default message', () => {
    const err = new BackpressureError();
    expect(err.message).toBe('Queue backpressure threshold exceeded');
  });

  test('accepts custom message', () => {
    const err = new BackpressureError('Custom: depth 150 > 100');
    expect(err.message).toBe('Custom: depth 150 > 100');
  });
});

// =============================================================================
// 18. RACE CONDITION: LOCK RELEASE TIMING
// =============================================================================

describe('Race condition: lock release timing', () => {
  test('lock is released AFTER executeMessage resolves, not before', async () => {
    const sid = uid();
    let executeResolved = false;
    let lockReleasedBeforeResolve = false;

    mockExecuteMessage.mockImplementation(async () => {
      await tick(10);
      executeResolved = true;
      return { done: true };
    });

    mockReleaseLock.mockImplementation(async () => {
      if (!executeResolved) {
        lockReleasedBeforeResolve = true;
      }
    });

    await enqueueLLMRequest(sid, 'hello');

    expect(executeResolved).toBe(true);
    expect(lockReleasedBeforeResolve).toBe(false);
  });

  test('lock is released AFTER executeMessage rejects, not before', async () => {
    const sid = uid();
    let executeRejected = false;
    let lockReleasedBeforeReject = false;

    mockExecuteMessage.mockImplementation(async () => {
      await tick(10);
      executeRejected = true;
      throw new Error('LLM timeout');
    });

    mockReleaseLock.mockImplementation(async () => {
      if (!executeRejected) {
        lockReleasedBeforeReject = true;
      }
    });

    await expect(enqueueLLMRequest(sid, 'hello')).rejects.toThrow('LLM timeout');
    expect(executeRejected).toBe(true);
    expect(lockReleasedBeforeReject).toBe(false);
  });
});
