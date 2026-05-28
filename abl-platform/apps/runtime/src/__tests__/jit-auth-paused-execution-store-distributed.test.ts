import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RedisMessageHandler = (channel: string, message: string) => void;
type RedisErrorHandler = (error: Error) => void;

class MockRedisSubscriber {
  private channels = new Set<string>();
  private messageHandler: RedisMessageHandler | null = null;
  private errorHandler: RedisErrorHandler | null = null;

  constructor(private readonly state: MockRedisState) {}

  on(event: 'message' | 'error', handler: RedisMessageHandler | RedisErrorHandler): void {
    if (event === 'message') {
      this.messageHandler = handler as RedisMessageHandler;
      return;
    }

    this.errorHandler = handler as RedisErrorHandler;
  }

  async subscribe(channel: string): Promise<void> {
    this.channels.add(channel);
    this.state.subscribers.add(this);
  }

  async quit(): Promise<void> {
    this.state.subscribers.delete(this);
    this.channels.clear();
  }

  isSubscribed(channel: string): boolean {
    return this.channels.has(channel);
  }

  emit(channel: string, message: string): void {
    if (!this.channels.has(channel) || !this.messageHandler) {
      return;
    }

    this.messageHandler(channel, message);
  }
}

class MockRedisState {
  store = new Map<string, string>();
  subscribers = new Set<MockRedisSubscriber>();
}

class MockRedisClient {
  constructor(private readonly state: MockRedisState) {}

  async set(key: string, value: string, mode: string, ttl: number): Promise<'OK'> {
    this.state.store.set(key, value);
    if ((mode === 'EX' || mode === 'PX') && ttl > 0) {
      const ttlMs = mode === 'EX' ? ttl * 1000 : ttl;
      const timer = setTimeout(() => {
        this.state.store.delete(key);
      }, ttlMs);
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
      }
    }
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.state.store.get(key) ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.state.store.delete(key)) {
        deleted++;
      }
    }
    return deleted;
  }

  async scan(
    _cursor: string,
    _matchLabel: string,
    pattern: string,
    _countLabel: string,
    _count: number,
  ): Promise<[string, string[]]> {
    const prefix = pattern.replace('*', '');
    const keys = [...this.state.store.keys()].filter((key) => key.startsWith(prefix));
    return ['0', keys];
  }

  async publish(channel: string, message: string): Promise<number> {
    let delivered = 0;
    for (const subscriber of this.state.subscribers) {
      if (!subscriber.isSubscribed(channel)) {
        continue;
      }
      // Deliver asynchronously to match real Redis pub/sub behaviour.
      // Synchronous delivery causes unhandled rejections when the signal
      // handler rejects a pause promise before the caller can await it.
      queueMicrotask(() => subscriber.emit(channel, message));
      delivered++;
    }
    return delivered;
  }

  duplicate(): MockRedisSubscriber {
    return new MockRedisSubscriber(this.state);
  }
}

const redisState = new MockRedisState();
const redisClient = new MockRedisClient(redisState);
const redisAvailability = { available: true };

vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: () => redisClient,
  getRedisHandle: () =>
    redisAvailability.available
      ? {
          client: redisClient,
          isReady: () => true,
          duplicate: () => redisClient.duplicate(),
          disconnect: async () => {},
        }
      : null,
  isRedisAvailable: () => redisAvailability.available,
}));

vi.mock('@agent-platform/redis', async () => {
  const actual =
    await vi.importActual<typeof import('@agent-platform/redis')>('@agent-platform/redis');
  return {
    ...actual,
    createSubscriber: (handle: { client: { duplicate(): unknown } }) => handle.client.duplicate(),
  };
});

import {
  AuthCancelledError,
  PausedExecutionStore,
  SessionDisconnectedError,
} from '../services/auth-profile/paused-execution-store.js';

function makePausedData(toolCallId: string, sessionId = 'session-1') {
  return {
    sessionId,
    toolCallId,
    authProfileRef: 'google-oauth',
    toolName: 'calendar_lookup',
    pausedAt: Date.now(),
    timeoutMs: 5000,
  };
}

describe('PausedExecutionStore distributed coordination', () => {
  let ownerStore: PausedExecutionStore;
  let remoteStore: PausedExecutionStore;

  beforeEach(async () => {
    redisState.store.clear();
    redisState.subscribers.clear();
    redisAvailability.available = true;
    ownerStore = new PausedExecutionStore();
    remoteStore = new PausedExecutionStore();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  afterEach(() => {
    ownerStore.destroy();
    remoteStore.destroy();
    redisState.store.clear();
    redisState.subscribers.clear();
  });

  it('resolveDistributed resolves a paused execution owned by another store', async () => {
    const paused = makePausedData('tc-remote-resolve');
    const pausePromise = ownerStore.pause(paused);
    await pausePromise.ready;

    await expect(remoteStore.resolveDistributed(paused.sessionId, paused.toolCallId)).resolves.toBe(
      'handled',
    );
    await expect(pausePromise).resolves.toBeUndefined();
    expect(ownerStore.has(paused.toolCallId)).toBe(false);
  });

  it('rejectDistributed rejects a paused execution owned by another store', async () => {
    const paused = makePausedData('tc-remote-reject');
    const pausePromise = ownerStore.pause(paused);
    await pausePromise.ready;

    await expect(
      remoteStore.rejectDistributed(paused.sessionId, paused.toolCallId, 'cancelled'),
    ).resolves.toBe('handled');
    await expect(pausePromise).rejects.toThrow(AuthCancelledError);
  });

  it('cleanupSession rejects paused executions owned by another store', async () => {
    const paused = makePausedData('tc-remote-cleanup', 'session-disconnect');
    const pausePromise = ownerStore.pause(paused);
    await pausePromise.ready;

    // Attach the rejection handler BEFORE triggering cleanup so the
    // promise rejection is observed immediately (avoids unhandled rejection).
    const rejectionAssertion = expect(pausePromise).rejects.toThrow(SessionDisconnectedError);

    await remoteStore.cleanupSession(paused.sessionId, 'disconnect');

    await rejectionAssertion;
    expect(ownerStore.has(paused.toolCallId)).toBe(false);
  });

  it('reports delivery_failed when a Redis key exists but no owner handles the signal', async () => {
    await redisClient.set(
      'paused-exec:session-orphan:tc-orphan',
      JSON.stringify(makePausedData('tc-orphan', 'session-orphan')),
      'EX',
      30,
    );

    await expect(remoteStore.resolveDistributed('session-orphan', 'tc-orphan')).resolves.toBe(
      'delivery_failed',
    );
  });

  it('reports unavailable instead of missing when Redis is down', async () => {
    redisAvailability.available = false;

    await expect(remoteStore.resolveDistributed('session-missing', 'tc-missing')).resolves.toBe(
      'unavailable',
    );
  });
});
