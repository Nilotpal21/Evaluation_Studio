import { describe, expect, test, vi } from 'vitest';
import type { OAuthRedisClient } from '../services/tool-oauth-service.js';
import {
  createRuntimeOAuthStateStore,
  type RuntimeOAuthStateStoreMode,
} from '../services/oauth-state-store-factory.js';

function createMockRedisClient(): OAuthRedisClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    getdel: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };
}

function expectSelectionMode(
  selection: ReturnType<typeof createRuntimeOAuthStateStore>,
  mode: RuntimeOAuthStateStoreMode,
): void {
  expect(selection.mode).toBe(mode);
}

describe('createRuntimeOAuthStateStore', () => {
  test('prefers Redis when a distributed store is available', () => {
    const selection = createRuntimeOAuthStateStore({
      redis: createMockRedisClient(),
      redisReady: true,
      nodeEnv: 'production',
    });

    expectSelectionMode(selection, 'redis');
    expect(selection.stateStore).not.toBeNull();
    expect(selection.stateStore?.constructor.name).toBe('RedisOAuthStateStore');
  });

  test('allows an in-memory store only in test mode', () => {
    const selection = createRuntimeOAuthStateStore({
      redis: null,
      nodeEnv: 'test',
    });

    expectSelectionMode(selection, 'memory-test');
    expect(selection.stateStore).not.toBeNull();
    expect(selection.stateStore?.constructor.name).toBe('InMemoryOAuthStateStore');
  });

  test('disables OAuth state storage outside tests when Redis is unavailable', () => {
    const selection = createRuntimeOAuthStateStore({
      redis: null,
      nodeEnv: 'development',
    });

    expectSelectionMode(selection, 'disabled');
    expect(selection.stateStore).toBeNull();
  });

  test('disables OAuth state storage outside tests when Redis is present but not ready', () => {
    const selection = createRuntimeOAuthStateStore({
      redis: createMockRedisClient(),
      redisReady: false,
      nodeEnv: 'production',
    });

    expectSelectionMode(selection, 'disabled');
    expect(selection.stateStore).toBeNull();
  });
});
