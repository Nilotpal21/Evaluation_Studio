/**
 * Tests for B1/B2: SSCAN + pipeline batching in session recovery.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRecoveryService } from '../../session/session-recovery-service.js';
import { ACTIVE_SESSIONS_SET } from '../../session/types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function buildSessionHash(ownerPod: string, tenantId = 'tenant-1') {
  return {
    tenantId,
    contactId: 'contact-1',
    channel: 'chat',
    provider: 'kore',
    providerSessionId: 'prov-1',
    state: 'active',
    ownerPod,
    lastHeartbeat: String(Date.now() - 60_000),
    createdAt: String(Date.now()),
    updatedAt: String(Date.now()),
  };
}

function createMockRedis(sessionKeys: string[], ownerPod: string) {
  const BATCH_SIZE = 100;
  // Split keys into SSCAN batches
  const batches: string[][] = [];
  for (let i = 0; i < sessionKeys.length; i += BATCH_SIZE) {
    batches.push(sessionKeys.slice(i, i + BATCH_SIZE));
  }
  if (batches.length === 0) batches.push([]);

  let sscanCallCount = 0;

  const redis = {
    sscan: vi.fn().mockImplementation(() => {
      const batchIndex = sscanCallCount;
      sscanCallCount++;
      const isLast = batchIndex >= batches.length - 1;
      return Promise.resolve([isLast ? '0' : String(batchIndex + 1), batches[batchIndex] ?? []]);
    }),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    // Cluster-safe: HGETALL/EXISTS now run as independent commands (Promise.all)
    // instead of in a pipeline. Each routes to its owning master in cluster mode.
    hgetall: vi.fn().mockImplementation(async () => buildSessionHash(ownerPod)),
    exists: vi.fn().mockResolvedValue(0), // Pod not alive
    srem: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn().mockImplementation(() => {
      const commands: Array<{ cmd: string; args: unknown[] }> = [];
      const pipe = {
        hgetall: vi.fn().mockImplementation((...args: unknown[]) => {
          commands.push({ cmd: 'hgetall', args });
          return pipe;
        }),
        exists: vi.fn().mockImplementation((...args: unknown[]) => {
          commands.push({ cmd: 'exists', args });
          return pipe;
        }),
        srem: vi.fn().mockImplementation((...args: unknown[]) => {
          commands.push({ cmd: 'srem', args });
          return pipe;
        }),
        exec: vi.fn().mockImplementation(() => {
          const results = commands.map((c) => {
            if (c.cmd === 'hgetall') {
              return [null, buildSessionHash(ownerPod)];
            }
            if (c.cmd === 'exists') {
              return [null, 0]; // Pod not alive
            }
            if (c.cmd === 'srem') {
              return [null, 1];
            }
            return [null, null];
          });
          commands.length = 0;
          return Promise.resolve(results);
        }),
      };
      return pipe;
    }),
  };

  return redis;
}

function createMockSessionStore() {
  return {
    get: vi.fn().mockResolvedValue(null),
    claimOrphanedSession: vi
      .fn()
      .mockResolvedValue({ success: true, session: { provider: 'kore' } }),
  };
}

function createMockAdapterRegistry() {
  return {
    get: vi.fn().mockReturnValue({
      recoverSessions: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

describe('SessionRecoveryService - SSCAN + pipeline', () => {
  it('uses SSCAN instead of SMEMBERS for recovery scan', async () => {
    const keys = Array.from({ length: 5 }, (_, i) => `agent_transfer:t1:c${i}:chat`);
    const redis = createMockRedis(keys, 'other-pod');
    const store = createMockSessionStore();
    const registry = createMockAdapterRegistry();

    const service = new SessionRecoveryService(
      redis as any,
      'my-pod',
      store as any,
      registry as any,
    );

    await service.recoverOrphanedSessions();

    expect(redis.sscan).toHaveBeenCalled();
    // Verify first call is with cursor '0'
    expect(redis.sscan.mock.calls[0][0]).toBe(ACTIVE_SESSIONS_SET);
    expect(redis.sscan.mock.calls[0][1]).toBe('0');
  });

  it('iterates through multiple SSCAN batches for 150+ keys', async () => {
    const keys = Array.from({ length: 150 }, (_, i) => `agent_transfer:t1:c${i}:chat`);
    const redis = createMockRedis(keys, 'other-pod');
    const store = createMockSessionStore();
    const registry = createMockAdapterRegistry();

    const service = new SessionRecoveryService(
      redis as any,
      'my-pod',
      store as any,
      registry as any,
    );

    await service.recoverOrphanedSessions();

    // With 150 keys at batch size 100, should have 2 SSCAN calls
    expect(redis.sscan).toHaveBeenCalledTimes(2);
  });

  it('issues parallel HGETALLs per session key (cluster-safe, no pipeline)', async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `agent_transfer:t1:c${i}:chat`);
    const redis = createMockRedis(keys, 'other-pod');
    const store = createMockSessionStore();
    const registry = createMockAdapterRegistry();

    const service = new SessionRecoveryService(
      redis as any,
      'my-pod',
      store as any,
      registry as any,
    );

    await service.recoverOrphanedSessions();

    // Cluster mode requires per-key routing — keys span tenants (different
    // hash slots), so HGETALLs MUST be issued as independent commands rather
    // than wrapped in a pipeline (which would CROSSSLOT).
    expect(redis.hgetall).toHaveBeenCalledTimes(keys.length);
  });

  it('issues parallel EXISTS calls for heartbeat checks (cluster-safe)', async () => {
    const keys = Array.from({ length: 5 }, (_, i) => `agent_transfer:t1:c${i}:chat`);
    const redis = createMockRedis(keys, 'other-pod');
    const store = createMockSessionStore();
    const registry = createMockAdapterRegistry();

    const service = new SessionRecoveryService(
      redis as any,
      'my-pod',
      store as any,
      registry as any,
    );

    await service.recoverOrphanedSessions();

    // Heartbeat keys span pod hostnames (different slots) — must be
    // independent EXISTS commands, not a pipeline.
    expect(redis.exists).toHaveBeenCalled();
    // All five sessions belong to 'other-pod', so we get one EXISTS per session.
    expect(redis.exists).toHaveBeenCalledTimes(keys.length);
  });

  it('handles empty active sessions set', async () => {
    const redis = createMockRedis([], 'other-pod');
    const store = createMockSessionStore();
    const registry = createMockAdapterRegistry();

    const service = new SessionRecoveryService(
      redis as any,
      'my-pod',
      store as any,
      registry as any,
    );

    const recovered = await service.recoverOrphanedSessions();

    expect(recovered).toBe(0);
    expect(redis.sscan).toHaveBeenCalledTimes(1);
  });

  it('records stats correctly after recovery', async () => {
    const keys = ['agent_transfer:t1:c1:chat'];
    const redis = createMockRedis(keys, 'other-pod');
    const store = createMockSessionStore();
    const registry = createMockAdapterRegistry();

    const service = new SessionRecoveryService(
      redis as any,
      'my-pod',
      store as any,
      registry as any,
    );

    await service.recoverOrphanedSessions();

    const stats = service.getStats();
    expect(stats.scansCompleted).toBe(1);
    expect(stats.lastScanAt).toBeGreaterThan(0);
  });
});
