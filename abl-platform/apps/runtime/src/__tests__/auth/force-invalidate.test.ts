/**
 * Force-Invalidate Subscriber Tests (INT-26)
 *
 * Covers:
 *   - Subscribe to Redis pub/sub channel
 *   - Receive message → cache.invalidate() called
 *   - Idempotent: invalidating already-evicted entry is a no-op
 *   - Malformed message handling (doesn't crash)
 *   - Start/stop lifecycle
 *   - State transitions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  AUTH_PROFILE_INVALIDATE_CHANNEL: 'auth-profile:invalidate',
  emitAuthProfileTraceEvent: vi.fn(),
}));

import {
  ForceInvalidateSubscriber,
  type RedisSubscriberPort,
} from '../../services/auth-profile/force-invalidate-subscriber.js';
import { AuthProfileCache } from '../../services/auth-profile/auth-profile-cache.js';

type MessageHandler = (channel: string, message: string) => void;

function createMockRedisSubscriber(): RedisSubscriberPort & {
  _messageHandlers: MessageHandler[];
  _simulateMessage: (channel: string, message: string) => void;
} {
  const handlers: MessageHandler[] = [];

  return {
    _messageHandlers: handlers,
    _simulateMessage(channel: string, message: string) {
      for (const handler of handlers) {
        handler(channel, message);
      }
    },
    on(event: string, handler: MessageHandler) {
      if (event === 'message') {
        handlers.push(handler);
      }
    },
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ForceInvalidateSubscriber', () => {
  let cache: AuthProfileCache;
  let mockSub: ReturnType<typeof createMockRedisSubscriber>;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new AuthProfileCache();
    mockSub = createMockRedisSubscriber();
  });

  function createSubscriber() {
    return new ForceInvalidateSubscriber({
      cache,
      createSubscriber: () => mockSub,
    });
  }

  it('subscribes to the invalidate channel on start', async () => {
    const subscriber = createSubscriber();
    await subscriber.start();

    expect(mockSub.subscribe).toHaveBeenCalledWith('auth-profile:invalidate');
    expect(subscriber.state).toBe('subscribed');
  });

  it('invalidates cache when message received', async () => {
    // Seed cache using CK1 key parts
    cache.set(
      { tenantId: 'tenant-1', authType: 'api_key', profileId: 'profile-1', profileVersion: 1 },
      {
        profileId: 'profile-1',
        authType: 'api_key',
        profileVersion: 1,
        config: {},
        secrets: { apiKey: 'key' },
      },
    );
    expect(
      cache.get({
        tenantId: 'tenant-1',
        authType: 'api_key',
        profileId: 'profile-1',
        profileVersion: 1,
      }),
    ).not.toBeNull();

    const subscriber = createSubscriber();
    await subscriber.start();

    // Simulate pub/sub message
    const payload = JSON.stringify({
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      timestamp: new Date().toISOString(),
    });
    mockSub._simulateMessage('auth-profile:invalidate', payload);

    // Cache should be invalidated
    expect(
      cache.get({
        tenantId: 'tenant-1',
        authType: 'api_key',
        profileId: 'profile-1',
        profileVersion: 1,
      }),
    ).toBeNull();
  });

  it('invalidating already-evicted entry is a no-op (idempotent)', async () => {
    // Cache is empty — no entry to evict
    const subscriber = createSubscriber();
    await subscriber.start();

    const payload = JSON.stringify({
      profileId: 'nonexistent',
      tenantId: 'tenant-1',
      projectId: null,
    });

    // Should not throw
    mockSub._simulateMessage('auth-profile:invalidate', payload);

    expect(cache.size).toBe(0);
  });

  it('handles malformed JSON gracefully', async () => {
    const subscriber = createSubscriber();
    await subscriber.start();

    // Should not throw
    mockSub._simulateMessage('auth-profile:invalidate', 'not-json{{{');
    expect(subscriber.state).toBe('subscribed');
  });

  it('ignores messages on other channels', async () => {
    const ck1 = {
      tenantId: 'tenant-1',
      authType: 'api_key',
      profileId: 'profile-1',
      profileVersion: 1,
    };
    cache.set(ck1, {
      profileId: 'profile-1',
      authType: 'api_key',
      profileVersion: 1,
      config: {},
      secrets: { apiKey: 'key' },
    });

    const subscriber = createSubscriber();
    await subscriber.start();

    const payload = JSON.stringify({
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      projectId: null,
    });
    mockSub._simulateMessage('some-other-channel', payload);

    // Cache should NOT be invalidated
    expect(cache.get(ck1)).not.toBeNull();
  });

  it('handles missing tenantId in payload', async () => {
    const subscriber = createSubscriber();
    await subscriber.start();

    const payload = JSON.stringify({ profileId: 'p1' });
    // Should not throw
    mockSub._simulateMessage('auth-profile:invalidate', payload);
    expect(subscriber.state).toBe('subscribed');
  });

  it('transitions through lifecycle states correctly', async () => {
    const subscriber = createSubscriber();
    expect(subscriber.state).toBe('idle');

    await subscriber.start();
    expect(subscriber.state).toBe('subscribed');

    await subscriber.stop();
    expect(subscriber.state).toBe('stopped');
  });

  it('is idempotent on repeated start calls', async () => {
    const subscriber = createSubscriber();
    await subscriber.start();
    await subscriber.start(); // second call

    expect(mockSub.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.state).toBe('subscribed');
  });

  it('is idempotent on repeated stop calls', async () => {
    const subscriber = createSubscriber();
    await subscriber.start();
    await subscriber.stop();
    await subscriber.stop(); // second call

    expect(mockSub.quit).toHaveBeenCalledTimes(1);
    expect(subscriber.state).toBe('stopped');
  });

  it('handles null Redis subscriber gracefully', async () => {
    const subscriber = new ForceInvalidateSubscriber({
      cache,
      createSubscriber: () => null,
    });

    await subscriber.start();
    expect(subscriber.state).toBe('idle');
  });

  it('invalidates all entries for a tenant when profileId is present', async () => {
    // Seed multiple cache entries for same tenant using CK1 key parts
    cache.set(
      { tenantId: 'tenant-1', authType: 'api_key', profileId: 'profile-1', profileVersion: 1 },
      {
        profileId: 'profile-1',
        authType: 'api_key',
        profileVersion: 1,
        config: {},
        secrets: { apiKey: 'key1' },
      },
    );
    cache.set(
      {
        tenantId: 'tenant-1',
        authType: 'api_key',
        profileId: 'profile-1',
        profileVersion: 1,
        scopeHash: 'staging',
      },
      {
        profileId: 'profile-1',
        authType: 'api_key',
        profileVersion: 1,
        config: {},
        secrets: { apiKey: 'key2' },
      },
    );
    cache.set(
      { tenantId: 'tenant-1', authType: 'bearer', profileId: 'profile-2', profileVersion: 1 },
      {
        profileId: 'profile-2',
        authType: 'bearer',
        profileVersion: 1,
        config: {},
        secrets: { token: 'tok' },
      },
    );

    const subscriber = createSubscriber();
    await subscriber.start();

    const payload = JSON.stringify({
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      projectId: null,
    });
    mockSub._simulateMessage('auth-profile:invalidate', payload);

    // profile-1 entries should be evicted (both scope variants)
    expect(
      cache.get({
        tenantId: 'tenant-1',
        authType: 'api_key',
        profileId: 'profile-1',
        profileVersion: 1,
      }),
    ).toBeNull();
    expect(
      cache.get({
        tenantId: 'tenant-1',
        authType: 'api_key',
        profileId: 'profile-1',
        profileVersion: 1,
        scopeHash: 'staging',
      }),
    ).toBeNull();
    // profile-2 should remain
    expect(
      cache.get({
        tenantId: 'tenant-1',
        authType: 'bearer',
        profileId: 'profile-2',
        profileVersion: 1,
      }),
    ).not.toBeNull();
  });
});
