import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKSessionTokenPayload } from '@agent-platform/shared-auth';

interface StoredEntry {
  value: string;
  expiresAtMs: number;
}

const redisEntries = new Map<string, StoredEntry>();
let redisAvailable = true;

const redisClient = {
  async set(
    key: string,
    value: string,
    mode: 'EX',
    ttlSeconds: number,
    condition: 'NX',
  ): Promise<'OK' | null> {
    expect(mode).toBe('EX');
    expect(condition).toBe('NX');
    if (redisEntries.has(key)) {
      return null;
    }
    redisEntries.set(key, { value, expiresAtMs: Date.now() + ttlSeconds * 1000 });
    return 'OK';
  },
  async getdel(key: string): Promise<string | null> {
    const entry = redisEntries.get(key);
    redisEntries.delete(key);
    if (!entry || entry.expiresAtMs <= Date.now()) {
      return null;
    }
    return entry.value;
  },
};

vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: () => (redisAvailable ? redisClient : null),
}));

const { consumeSdkWsTicket, issueSdkWsTicket } =
  await import('../../services/identity/sdk-ws-ticket-store.js');

function createPayload(): SDKSessionTokenPayload {
  return {
    type: 'sdk_session',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    channelId: 'channel-1',
    sessionId: 'session-1',
    sessionPrincipal: 'session-principal-1',
    permissions: ['session:send_message', 'session:read'],
    authScope: 'session',
    identityTier: 0,
    verificationMethod: 'none',
    bootstrapType: 'public_key',
    bootstrapKeyId: 'pk_original',
    bootstrapExpiresAt: Date.now() + 60_000,
    tokenEnvelope: 'signed',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  };
}

describe('sdk-ws-ticket-store', () => {
  beforeEach(() => {
    redisEntries.clear();
    redisAvailable = true;
  });

  it('issues and consumes a ticket once', async () => {
    const payload = createPayload();
    const issued = await issueSdkWsTicket(payload, 'signed');
    expect(issued.success).toBe(true);
    if (!issued.success) {
      return;
    }

    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]+$/);
    expect([...redisEntries.keys()].some((key) => key.includes(issued.ticket))).toBe(false);
    const storedRecord = JSON.parse([...redisEntries.values()][0].value) as {
      payload: Record<string, unknown>;
    };
    expect(storedRecord.payload.bootstrapKeyId).toBe('pk_original');
    expect(storedRecord.payload.bootstrapExpiresAt).toBe(payload.bootstrapExpiresAt);
    expect(storedRecord.payload.tokenEnvelope).toBeUndefined();

    const firstConsume = await consumeSdkWsTicket(issued.ticket);
    expect(firstConsume.success).toBe(true);
    if (firstConsume.success) {
      expect(firstConsume.record.payload.projectId).toBe('project-1');
      expect(firstConsume.record.envelope).toBe('signed');
    }

    const replay = await consumeSdkWsTicket(issued.ticket);
    expect(replay).toEqual({ success: false, reason: 'missing' });
  });

  it('fails closed when Redis is unavailable', async () => {
    redisAvailable = false;

    await expect(issueSdkWsTicket(createPayload(), 'jwe')).resolves.toEqual({
      success: false,
      reason: 'unavailable',
    });
    await expect(consumeSdkWsTicket('ticket-1')).resolves.toEqual({
      success: false,
      reason: 'unavailable',
    });
  });
});
