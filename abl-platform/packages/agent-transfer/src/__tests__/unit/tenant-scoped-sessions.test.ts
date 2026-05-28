/**
 * Tests for B5: getActiveSessions tenant isolation via SSCAN MATCH.
 */
import { describe, it, expect, vi } from 'vitest';
import { TransferSessionStore } from '../../session/transfer-session-store.js';
import { ACTIVE_SESSIONS_SET } from '../../session/types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockRedis(allKeys: string[]) {
  return {
    smembers: vi.fn().mockResolvedValue(allKeys),
    sscan: vi.fn().mockImplementation((_key: string, _cursor: string, ..._args: unknown[]) => {
      // Extract MATCH pattern from args
      const matchIdx = _args.indexOf('MATCH');
      const pattern = matchIdx >= 0 ? (_args[matchIdx + 1] as string) : null;

      // Filter keys by pattern (simple glob matching)
      let filtered = allKeys;
      if (pattern) {
        const prefix = pattern.replace('*', '');
        filtered = allKeys.filter((k) => k.startsWith(prefix));
      }

      // Return all at once (cursor = '0' means done)
      return Promise.resolve(['0', filtered]);
    }),
  };
}

describe('TransferSessionStore.getActiveSessions', () => {
  const allKeys = [
    'agent_transfer:tenant-1:c1:chat',
    'agent_transfer:tenant-1:c2:voice',
    'agent_transfer:tenant-2:c3:chat',
    'agent_transfer:tenant-2:c4:email',
    'agent_transfer:tenant-3:c5:chat',
  ];

  it('without tenantId: returns all sessions via SMEMBERS', async () => {
    const redis = createMockRedis(allKeys);
    const store = new TransferSessionStore(redis as any);

    const result = await store.getActiveSessions();

    expect(result).toEqual(allKeys);
    expect(redis.smembers).toHaveBeenCalledWith(ACTIVE_SESSIONS_SET);
    expect(redis.sscan).not.toHaveBeenCalled();
  });

  it("with tenantId: returns only that tenant's sessions via SSCAN MATCH", async () => {
    const redis = createMockRedis(allKeys);
    const store = new TransferSessionStore(redis as any);

    const result = await store.getActiveSessions('tenant-1');

    expect(result).toEqual(['agent_transfer:tenant-1:c1:chat', 'agent_transfer:tenant-1:c2:voice']);
    expect(redis.sscan).toHaveBeenCalled();
    expect(redis.smembers).not.toHaveBeenCalled();
  });

  it('with tenantId: uses correct MATCH pattern', async () => {
    const redis = createMockRedis(allKeys);
    const store = new TransferSessionStore(redis as any);

    await store.getActiveSessions('tenant-2');

    expect(redis.sscan).toHaveBeenCalledWith(
      ACTIVE_SESSIONS_SET,
      '0',
      'MATCH',
      'agent_transfer:tenant-2:*',
      'COUNT',
      100,
    );
  });

  it('with nonexistent tenantId: returns empty array', async () => {
    const redis = createMockRedis(allKeys);
    const store = new TransferSessionStore(redis as any);

    const result = await store.getActiveSessions('tenant-999');

    expect(result).toEqual([]);
  });

  it('tenant isolation: tenant-1 cannot see tenant-2 sessions', async () => {
    const redis = createMockRedis(allKeys);
    const store = new TransferSessionStore(redis as any);

    const tenant1Sessions = await store.getActiveSessions('tenant-1');
    const tenant2Sessions = await store.getActiveSessions('tenant-2');

    expect(tenant1Sessions.every((k) => k.includes('tenant-1'))).toBe(true);
    expect(tenant2Sessions.every((k) => k.includes('tenant-2'))).toBe(true);
    // No overlap
    expect(tenant1Sessions.filter((k) => tenant2Sessions.includes(k))).toEqual([]);
  });
});
