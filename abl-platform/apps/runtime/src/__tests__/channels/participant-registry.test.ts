import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  OMNICHANNEL_MAX_CONNECTIONS_PER_SESSION,
  OMNICHANNEL_PARTICIPANT_TTL_SECONDS,
} from '@agent-platform/config/constants';

const mockGetRedisClient = vi.fn();

vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: (...args: unknown[]) => mockGetRedisClient(...args),
  getRedisHandle: () => null,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { addParticipant } from '../../services/omnichannel/participant-registry.js';

function createRedisMock(evalResult = 1) {
  return {
    eval: vi.fn(async () => evalResult),
    scard: vi.fn(async () => {
      throw new Error('scard should not be called');
    }),
    sadd: vi.fn(async () => {
      throw new Error('sadd should not be called');
    }),
    expire: vi.fn(async () => {
      throw new Error('expire should not be called');
    }),
  };
}

describe('participant-registry addParticipant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('uses a single Redis Lua script to enforce the participant cap atomically', async () => {
    const redis = createRedisMock();
    mockGetRedisClient.mockReturnValue(redis);

    const participant = {
      participantId: 'ws:sdk-session-1:abcd1234',
      sessionId: 'live-session-1',
      contactId: 'contact-123',
      surface: 'web' as const,
      channel: 'text' as const,
      mode: 'typed' as const,
      interactive: true,
      attachedAt: new Date('2026-04-06T12:00:00Z'),
    };

    await addParticipant('live-session-1', participant);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SCARD', KEYS[1])"),
      1,
      'omnichannel:participants:live-session-1',
      JSON.stringify(participant),
      String(OMNICHANNEL_MAX_CONNECTIONS_PER_SESSION),
      String(OMNICHANNEL_PARTICIPANT_TTL_SECONDS),
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SADD', KEYS[1], ARGV[1])"),
      1,
      'omnichannel:participants:live-session-1',
      JSON.stringify(participant),
      String(OMNICHANNEL_MAX_CONNECTIONS_PER_SESSION),
      String(OMNICHANNEL_PARTICIPANT_TTL_SECONDS),
    );
    expect(redis.scard).not.toHaveBeenCalled();
    expect(redis.sadd).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
  });

  test('throws when the atomic Lua script reports that the session is already full', async () => {
    const redis = createRedisMock(-1);
    mockGetRedisClient.mockReturnValue(redis);

    await expect(
      addParticipant('live-session-1', {
        participantId: 'ws:sdk-session-1:abcd1234',
        sessionId: 'live-session-1',
        contactId: 'contact-123',
        surface: 'web',
        channel: 'text',
        mode: 'typed',
        interactive: true,
        attachedAt: new Date('2026-04-06T12:00:00Z'),
      }),
    ).rejects.toThrow(
      `Maximum connections per session (${OMNICHANNEL_MAX_CONNECTIONS_PER_SESSION}) exceeded`,
    );

    expect(redis.scard).not.toHaveBeenCalled();
    expect(redis.sadd).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
  });
});
