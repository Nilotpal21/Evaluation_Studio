/**
 * Message Persistence Queue — ordering tests
 *
 * Verifies that parallel persistMessage calls for the same session
 * always enqueue messages in call order (user before assistant),
 * regardless of async init races.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared state for the mock message store
const directWriteMessages: Array<{ sessionId: string; role: string; content: string }> = [];
let addMessageImpl: (msg: any) => Promise<void> = async (msg) => {
  directWriteMessages.push(msg);
};

vi.mock('@agent-platform/database/models', () => ({}));

// Mock dependencies before importing the module under test
vi.mock('../services/stores/store-factory.js', () => ({
  getStores: () => ({
    message: {
      addMessage: (msg: any) => addMessageImpl(msg),
    },
  }),
}));

vi.mock('../repos/session-repo.js', () => ({
  batchCreateMessages: vi.fn().mockResolvedValue(undefined),
  applySessionTurnUpdate: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => true),
}));

// Mock Redis as unavailable so we test the direct-write fallback path
vi.mock('../services/redis/redis-client.js', () => ({
  isRedisAvailable: () => false,
  getRedisClient: () => null,
  getRedisHandle: () => null,
}));

import {
  persistMessage,
  flushMessageQueue,
  _resetForTest,
  _getMessageBuffer,
  _setBullAvailable,
} from '../services/message-persistence-queue.js';

describe('Message Persistence Queue — ordering', () => {
  beforeEach(() => {
    _resetForTest();
    directWriteMessages.length = 0;
    addMessageImpl = async (msg) => {
      directWriteMessages.push(msg);
    };
  });

  it('preserves call order when two messages are fired concurrently (direct write fallback)', async () => {
    // Fire both concurrently — same pattern as WS handler (fire-and-forget)
    const p1 = persistMessage('session-1', 'user', 'hello');
    const p2 = persistMessage('session-1', 'assistant', 'welcome back!');

    await Promise.all([p1, p2]);

    expect(directWriteMessages).toHaveLength(2);
    expect(directWriteMessages[0].role).toBe('user');
    expect(directWriteMessages[0].content).toBe('hello');
    expect(directWriteMessages[1].role).toBe('assistant');
    expect(directWriteMessages[1].content).toBe('welcome back!');
  });

  it('preserves call order for many parallel messages on same session', async () => {
    const roles = ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'];
    const contents = ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5', 'msg-6'];

    // Fire all 6 concurrently
    const promises = roles.map((role, i) => persistMessage('session-1', role, contents[i]));
    await Promise.all(promises);

    expect(directWriteMessages).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(directWriteMessages[i].role).toBe(roles[i]);
      expect(directWriteMessages[i].content).toBe(contents[i]);
    }
  });

  it('different sessions do not block each other', async () => {
    // Fire messages for two different sessions concurrently
    const promises = [
      persistMessage('session-A', 'user', 'A-user'),
      persistMessage('session-B', 'user', 'B-user'),
      persistMessage('session-A', 'assistant', 'A-assistant'),
      persistMessage('session-B', 'assistant', 'B-assistant'),
    ];
    await Promise.all(promises);

    expect(directWriteMessages).toHaveLength(4);

    // Session A messages should be in order relative to each other
    const sessionA = directWriteMessages.filter((m) => m.sessionId === 'session-A');
    expect(sessionA[0].role).toBe('user');
    expect(sessionA[1].role).toBe('assistant');

    // Session B messages should be in order relative to each other
    const sessionB = directWriteMessages.filter((m) => m.sessionId === 'session-B');
    expect(sessionB[0].role).toBe('user');
    expect(sessionB[1].role).toBe('assistant');
  });

  it('preserves order in BullMQ buffer path', async () => {
    // Simulate BullMQ being available (messages go to buffer, not direct write)
    _setBullAvailable(true);

    // Fire concurrently
    const p1 = persistMessage('session-1', 'user', 'hello');
    const p2 = persistMessage('session-1', 'assistant', 'hi there');

    await Promise.all([p1, p2]);

    const buffer = _getMessageBuffer('session-1');
    expect(buffer).toBeDefined();
    expect(buffer).toHaveLength(2);
    expect(buffer![0].role).toBe('user');
    expect(buffer![0].content).toBe('hello');
    expect(buffer![1].role).toBe('assistant');
    expect(buffer![1].content).toBe('hi there');
  });

  it('buffer enqueuedAt timestamps are monotonically increasing', async () => {
    _setBullAvailable(true);

    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(persistMessage('session-1', i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`));
    }
    await Promise.all(promises);

    const buffer = _getMessageBuffer('session-1')!;
    expect(buffer).toHaveLength(10);

    for (let i = 1; i < buffer.length; i++) {
      expect(buffer[i].enqueuedAt).toBeGreaterThanOrEqual(buffer[i - 1].enqueuedAt);
    }
  });

  it('error in one message does not break the chain for subsequent messages', async () => {
    let callCount = 0;
    addMessageImpl = async (msg) => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Simulated DB failure');
      }
      directWriteMessages.push(msg);
    };

    // Fire 3 messages — second one will fail
    const p1 = persistMessage('session-1', 'user', 'first');
    const p2 = persistMessage('session-1', 'assistant', 'second-will-fail');
    const p3 = persistMessage('session-1', 'user', 'third-should-succeed');

    // p2 will reject but shouldn't break p3
    await Promise.allSettled([p1, p2, p3]);

    // First and third should succeed, second failed
    expect(directWriteMessages).toHaveLength(2);
    expect(directWriteMessages[0].content).toBe('first');
    expect(directWriteMessages[1].content).toBe('third-should-succeed');
  });
});
