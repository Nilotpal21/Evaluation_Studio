/**
 * Tests for PausedExecutionStore (Phase 5 — Tasks 5.4, 5.7, 5.8, 5.17)
 *
 * Verifies:
 * - Pause → key exists
 * - Resolve → promise resolves
 * - Timeout → rejects with AuthTimeoutError
 * - Cancel → rejects with user-friendly message
 * - Session cleanup → no orphaned state
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PausedExecutionStore,
  AuthTimeoutError,
  AuthCancelledError,
  type PausedExecutionData,
} from '../services/auth-profile/paused-execution-store.js';

// Mock Redis to be unavailable (in-memory only for tests)
vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
  isRedisAvailable: () => false,
}));

function makePausedData(overrides: Partial<PausedExecutionData> = {}): PausedExecutionData {
  return {
    sessionId: 'session-1',
    toolCallId: 'tc_' + Math.random().toString(36).slice(2, 8),
    authProfileRef: 'google-oauth',
    toolName: 'calendar-lookup',
    pausedAt: Date.now(),
    timeoutMs: 5000, // 5 seconds for fast tests
    ...overrides,
  };
}

describe('PausedExecutionStore', () => {
  let store: PausedExecutionStore;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    store = new PausedExecutionStore();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  describe('pause and has (Task 5.4)', () => {
    it('pause creates a pending entry', async () => {
      const data = makePausedData();
      // Don't await — the promise waits for resolve/reject
      const promise = store.pause(data);

      // Allow async setup (writeRedisKey) to complete
      await vi.advanceTimersByTimeAsync(10);

      expect(store.has(data.toolCallId)).toBe(true);
      expect(store.size).toBe(1);

      // Clean up
      store.resolve(data.toolCallId);
      return promise;
    });

    it('get returns paused data', async () => {
      const data = makePausedData();
      const promise = store.pause(data);
      await vi.advanceTimersByTimeAsync(10);

      const retrieved = store.get(data.toolCallId);
      expect(retrieved).toEqual(data);

      store.resolve(data.toolCallId);
      return promise;
    });

    it('get returns null for unknown toolCallId', () => {
      expect(store.get('unknown-id')).toBeNull();
    });
  });

  describe('resolve (Task 5.6)', () => {
    it('resolve resolves the paused promise', async () => {
      const data = makePausedData();
      const promise = store.pause(data);
      await vi.advanceTimersByTimeAsync(10);

      expect(store.has(data.toolCallId)).toBe(true);

      store.resolve(data.toolCallId);

      // Promise should resolve without error
      await expect(promise).resolves.toBeUndefined();
      expect(store.has(data.toolCallId)).toBe(false);
    });

    it('resolve on unknown toolCallId is a no-op', () => {
      // Should not throw
      store.resolve('nonexistent-id');
    });
  });

  describe('timeout (Task 5.7)', () => {
    it('rejects with AuthTimeoutError after TTL', async () => {
      const data = makePausedData({ timeoutMs: 100 });
      const promise = store.pause(data);
      await vi.advanceTimersByTimeAsync(10);

      // Advance time past the timeout
      vi.advanceTimersByTime(150);

      await expect(promise).rejects.toThrow(AuthTimeoutError);
      await expect(promise).rejects.toThrow(/timed out/);
      expect(store.has(data.toolCallId)).toBe(false);
    });

    it('AuthTimeoutError has user-friendly message', () => {
      const err = new AuthTimeoutError('google-oauth', 600000);
      expect(err.message).toContain('google-oauth');
      expect(err.message).toContain('10 minutes');
      expect(err.name).toBe('AuthTimeoutError');
    });
  });

  describe('cancellation (Task 5.8)', () => {
    it('reject with AuthCancelledError', async () => {
      const data = makePausedData();
      const promise = store.pause(data);
      await vi.advanceTimersByTimeAsync(10);

      store.reject(data.toolCallId, new AuthCancelledError());

      await expect(promise).rejects.toThrow(AuthCancelledError);
      await expect(promise).rejects.toThrow(/cancelled/i);
      expect(store.has(data.toolCallId)).toBe(false);
    });

    it('reject with custom error message', async () => {
      const data = makePausedData();
      const promise = store.pause(data);
      await vi.advanceTimersByTimeAsync(10);

      store.reject(data.toolCallId, new Error('Authorization cancelled by user'));

      await expect(promise).rejects.toThrow('Authorization cancelled by user');
    });
  });

  describe('cleanupSession (Task 5.17)', () => {
    it('cleans up all paused executions for a session', async () => {
      const data1 = makePausedData({ sessionId: 'session-A', toolCallId: 'tc_1' });
      const data2 = makePausedData({ sessionId: 'session-A', toolCallId: 'tc_2' });
      const data3 = makePausedData({ sessionId: 'session-B', toolCallId: 'tc_3' });

      const p1 = store.pause(data1).catch(() => {});
      const p2 = store.pause(data2).catch(() => {});
      const p3 = store.pause(data3);

      // Allow async writeRedisKey (mocked as no-op) to complete
      await vi.advanceTimersByTimeAsync(10);

      expect(store.size).toBe(3);

      await store.cleanupSession('session-A');

      // session-A entries should be gone
      expect(store.has('tc_1')).toBe(false);
      expect(store.has('tc_2')).toBe(false);
      // session-B entry should remain
      expect(store.has('tc_3')).toBe(true);
      expect(store.size).toBe(1);

      // Clean up
      store.resolve('tc_3');
      await p1;
      await p2;
      await p3;
    });

    it('cleanupSession is idempotent', async () => {
      await store.cleanupSession('nonexistent-session');
      expect(store.size).toBe(0);
    });

    it('cleanupSession with disconnect reason rejects pending executions with session disconnected error', async () => {
      const data = makePausedData({ sessionId: 'session-dc', toolCallId: 'tc_dc' });
      const promise = store.pause(data);
      await vi.advanceTimersByTimeAsync(10);

      await store.cleanupSession('session-dc', 'disconnect');

      await expect(promise).rejects.toThrow(/session.*disconnected/i);
      expect(store.has('tc_dc')).toBe(false);
    });
  });

  describe('getTimeoutMs', () => {
    it('returns default when env var not set', () => {
      delete process.env.JIT_AUTH_TIMEOUT_MS;
      expect(store.getTimeoutMs()).toBe(600000);
    });

    it('returns env var value when set', () => {
      process.env.JIT_AUTH_TIMEOUT_MS = '300000';
      expect(store.getTimeoutMs()).toBe(300000);
      delete process.env.JIT_AUTH_TIMEOUT_MS;
    });

    it('returns default for invalid env var', () => {
      process.env.JIT_AUTH_TIMEOUT_MS = 'not-a-number';
      expect(store.getTimeoutMs()).toBe(600000);
      delete process.env.JIT_AUTH_TIMEOUT_MS;
    });
  });
});
