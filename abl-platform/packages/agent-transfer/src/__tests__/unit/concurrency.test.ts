/**
 * Concurrency Tests
 *
 * Validates atomic operations via Lua scripts:
 * - Duplicate session creation rejected
 * - CAS claim prevents double-claim
 * - Leader election via SET NX
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { TransferSessionStore } from '../../session/transfer-session-store.js';
import { SessionRecoveryService } from '../../session/session-recovery-service.js';
import { RECOVERY_LEADER_KEY } from '../../session/types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('concurrency', () => {
  let redis: InstanceType<typeof Redis>;
  let store: TransferSessionStore;

  beforeEach(() => {
    redis = new Redis();
    store = new TransferSessionStore(redis as any);
  });

  describe('duplicate session creation', () => {
    it('rejects second creation for same tenant+contact+channel', async () => {
      const input = {
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-1',
        ownerPod: 'pod-1',
      };

      const first = await store.create(input);
      expect(first.success).toBe(true);

      const second = await store.create(input);
      expect(second.success).toBe(false);
      expect(second.error?.code).toBe('SESSION_EXISTS');
    });

    it('allows creation for different channels same contact', async () => {
      const base = {
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        provider: 'kore',
        ownerPod: 'pod-1',
      };

      // Use manual mock for eval since ioredis-mock doesn't support Lua scripts reliably
      const mockRedis = {
        eval: vi
          .fn()
          .mockResolvedValueOnce(1) // First create succeeds
          .mockResolvedValueOnce(1), // Second create succeeds (different channel)
        hgetall: vi.fn().mockResolvedValue({}),
        // create() now writes the cross-slot indexes via individual calls
        // (Promise.allSettled) instead of pipeline(), because ioredis Cluster
        // pipelines require same-slot keys.
        set: vi.fn().mockResolvedValue('OK'),
        sadd: vi.fn().mockResolvedValue(1),
      };
      const mockStore = new TransferSessionStore(mockRedis as any);

      const chat = await mockStore.create({
        ...base,
        channel: 'chat',
        providerSessionId: 'conv-chat',
      });
      const email = await mockStore.create({
        ...base,
        channel: 'email',
        providerSessionId: 'conv-email',
      });

      expect(chat.success).toBe(true);
      expect(email.success).toBe(true);

      // Verify they used different session keys
      const calls = mockRedis.eval.mock.calls;
      const key1 = calls[0][2]; // KEYS[1] = session key
      const key2 = calls[1][2];
      expect(key1).toContain(':chat');
      expect(key2).toContain(':email');
      expect(key1).not.toBe(key2);
    });
  });

  describe('CAS claim', () => {
    it('succeeds when ownerPod matches expected value', async () => {
      const sessionData = {
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-1',
        ownerPod: 'new-pod',
        state: 'initializing',
        metadata: '{}',
        providerData: '{}',
        lastHeartbeat: String(Date.now()),
        createdAt: String(Date.now()),
        updatedAt: String(Date.now()),
        ttl: '1800',
      };

      const mockRedis = {
        eval: vi.fn().mockResolvedValue(1), // CAS success
        hgetall: vi.fn().mockResolvedValue(sessionData),
        smembers: vi.fn().mockResolvedValue([]),
        // claimOrphanedSession swaps pod-set membership via individual
        // SREM/SADD (cross-slot in cluster mode).
        srem: vi.fn().mockResolvedValue(1),
        sadd: vi.fn().mockResolvedValue(1),
      };
      const mockStore = new TransferSessionStore(mockRedis as any);

      const key = 'agent_transfer:tenant-1:contact-1:chat';
      const result = await mockStore.claimOrphanedSession(key, 'dead-pod', 'new-pod');

      expect(result.success).toBe(true);
      expect(result.session).toBeDefined();
      expect(result.session!.ownerPod).toBe('new-pod');
    });

    it('fails when ownerPod has already changed (lost race)', async () => {
      const mockRedis = {
        eval: vi.fn().mockResolvedValue(0), // CAS failure
      };
      const mockStore = new TransferSessionStore(mockRedis as any);

      const key = 'agent_transfer:tenant-1:contact-1:chat';
      const result = await mockStore.claimOrphanedSession(key, 'dead-pod', 'new-pod');
      expect(result.success).toBe(false);
    });
  });

  describe('leader election', () => {
    it('only one of two pods becomes leader', async () => {
      const mockRegistry = { get: vi.fn() };

      const service1 = new SessionRecoveryService(
        redis as any,
        'pod-1',
        store,
        mockRegistry as any,
        { heartbeatIntervalMs: 100_000, leaderElectionIntervalMs: 100_000 },
      );

      const service2 = new SessionRecoveryService(
        redis as any,
        'pod-2',
        store,
        mockRegistry as any,
        { heartbeatIntervalMs: 100_000, leaderElectionIntervalMs: 100_000 },
      );

      await service1.tryBecomeLeader();
      await service2.tryBecomeLeader();

      // Only one should be leader
      const leaders = [service1.getIsLeader(), service2.getIsLeader()];
      expect(leaders.filter(Boolean).length).toBe(1);

      // The one who got it first should be leader
      expect(service1.getIsLeader()).toBe(true);
      expect(service2.getIsLeader()).toBe(false);

      // Verify the key value
      const leaderValue = await redis.get(RECOVERY_LEADER_KEY);
      expect(leaderValue).toBe('pod-1');

      await service1.stop();
      await service2.stop();
    });
  });
});
